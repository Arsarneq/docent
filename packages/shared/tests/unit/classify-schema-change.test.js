/**
 * classify-schema-change.test.js — Unit tests for the mechanical schema-change
 * classifier that drives auto-versioning. Each test encodes one rule from
 * docs/technical/session-format.md (patch/minor/major) plus the conservative
 * escalate-to-major bias for anything ambiguous.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange } from '../../../../scripts/classify-schema-change.js';
import { bumpVersion } from '../../../../scripts/auto-version-schemas.js';

// Minimal realistic schema shaped like the composed platform schemas.
function baseSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example/x.schema.json',
    title: 'X',
    version: '1.0.0',
    type: 'object',
    required: ['project', 'recordings'],
    additionalProperties: false,
    properties: {
      project: { $ref: '#/$defs/project' },
    },
    $defs: {
      project: {
        type: 'object',
        required: ['project_id', 'name'],
        additionalProperties: false,
        properties: {
          project_id: { type: 'string' },
          name: { type: 'string' },
          metadata: { type: 'object', description: 'optional' },
        },
      },
      capture_mode: { type: 'string', enum: ['accessibility', 'coordinate'] },
      action_click: {
        properties: { type: { const: 'click' }, x: { type: 'number' } },
        required: ['type', 'x'],
      },
      action: {
        oneOf: [{ $ref: '#/$defs/action_click' }],
      },
    },
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

describe('classifyChange: none', () => {
  it('identical schemas → none', () => {
    assert.equal(classifyChange(baseSchema(), baseSchema()).level, 'none');
  });

  it('ignores $id / title / version / $schema differences → none', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$id = 'https://example/other.json';
    b.title = 'Renamed';
    b.version = '9.9.9';
    b.$schema = 'https://json-schema.org/draft/2019-09/schema';
    assert.equal(classifyChange(a, b).level, 'none');
  });
});

describe('classifyChange: patch (description-only)', () => {
  it('changed description on a def → patch', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.metadata.description = 'clarified wording';
    assert.equal(classifyChange(a, b).level, 'patch');
  });

  it('added description where none existed → patch', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.description = 'now documented';
    assert.equal(classifyChange(a, b).level, 'patch');
  });
});

describe('classifyChange: x- annotations', () => {
  // `x-` keys are contract annotations the tooling reads (e.g.
  // `x-value-derived`). Introducing a KNOWN annotation documents existing
  // behaviour (patch — the add-is-documentation property is verified by
  // drift guards, per annotation kind); introducing an unknown kind, or
  // changing/removing any annotation, rewrites what the contract says, which
  // the classifier escalates (major, never-under-report). The def under
  // annotation exists in BOTH schemas — a wholly new def short-circuits
  // earlier as definition-added and never reaches the interception.

  it('known annotation added with value true → patch', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_click['x-value-derived'] = true;
    assert.equal(classifyChange(a, b).level, 'patch');
  });

  it('known annotation added with value false → patch', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_click['x-value-derived'] = false;
    assert.equal(classifyChange(a, b).level, 'patch');
  });

  it('unknown annotation kind added → major (never-under-report)', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_click['x-replay-critical'] = true;
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('annotation changed true → false → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    a.$defs.action_click['x-value-derived'] = true;
    b.$defs.action_click['x-value-derived'] = false;
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('annotation changed false → true → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    a.$defs.action_click['x-value-derived'] = false;
    b.$defs.action_click['x-value-derived'] = true;
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('annotation removed → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    a.$defs.action_click['x-value-derived'] = true;
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('object-valued annotation change does not re-enter the walk → major, once', () => {
    const a = baseSchema();
    const b = baseSchema();
    a.$defs.action_click['x-meta'] = { nested: { deep: 1 } };
    b.$defs.action_click['x-meta'] = { nested: { deep: 2 } };
    const result = classifyChange(a, b);
    assert.equal(result.level, 'major');
    assert.equal(
      result.reasons.filter((r) => r.message.includes('x-meta')).length,
      1,
      'the annotation is classified once, not recursed into',
    );
  });
});

describe('classifyChange: minor', () => {
  it('new OPTIONAL property → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.note = { type: 'string' };
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('new enum value → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.enum = ['accessibility', 'coordinate', 'hybrid'];
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('new action type (oneOf branch) → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_scroll = { properties: { type: { const: 'scroll' } }, required: ['type'] };
    b.$defs.action.oneOf = [...b.$defs.action.oneOf, { $ref: '#/$defs/action_scroll' }];
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('type widened (string → [string, null]) → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.name = { type: ['string', 'null'] };
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('additionalProperties false → true → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.additionalProperties = true;
    assert.equal(classifyChange(a, b).level, 'minor');
  });
});

describe('classifyChange: major', () => {
  it('new REQUIRED property → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.owner = { type: 'string' };
    b.$defs.project.required = ['project_id', 'name', 'owner'];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('removed property → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    delete b.$defs.project.properties.metadata;
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('field newly required (existing optional) → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.required = ['project_id', 'name', 'metadata'];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('field no longer required → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.required = ['project_id'];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('removed enum value → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.enum = ['accessibility'];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('changed type → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_click.properties.x = { type: 'string' };
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('changed const → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action_click.properties.type = { const: 'tap' };
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('removed action type (oneOf branch) → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.action.oneOf = [];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('tightened constraint (added pattern) → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.project_id = { type: 'string', pattern: '^x' };
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('additionalProperties true → false → major', () => {
    const a = baseSchema();
    a.$defs.project.additionalProperties = true;
    const b = baseSchema();
    b.$defs.project.additionalProperties = false;
    assert.equal(classifyChange(a, b).level, 'major');
  });
});

describe('classifyChange: highest level wins across mixed changes', () => {
  it('a description tweak + a removed field → major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.metadata.description = 'tweaked';
    delete b.$defs.project.properties.name;
    b.$defs.project.required = ['project_id'];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('a description tweak + a new optional field → minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.description = 'tweaked';
    b.$defs.project.properties.note = { type: 'string' };
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('reasons array records each detected change', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.note = { type: 'string' };
    const { reasons } = classifyChange(a, b);
    assert.ok(reasons.some((r) => r.message.includes('note')));
  });
});

describe('bumpVersion', () => {
  it('applies each level correctly', () => {
    assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
    assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(bumpVersion('1.2.3', 'none'), '1.2.3');
  });

  it('throws on invalid semver', () => {
    assert.throws(() => bumpVersion('1.2', 'patch'));
  });
});

// Regression: introducing a constraint KEYWORD (enum / oneOf / anyOf / allOf)
// on an existing node previously fell through the empty-set diff and read as
// value/branch "additions" (minor) — a tightening shipped as a minor bump,
// violating the never-under-report charter. Found in the review that aligned
// the version-bump rules between this classifier and
// docs/technical/session-format.md (no tracked issue; surfaced in that PR).
describe('classifyChange: constraint-keyword introduction escalates to major', () => {
  it('regression_enum_introduced_on_unconstrained_field_is_major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.name = { type: 'string', enum: ['a', 'b'] };
    const { level, reasons } = classifyChange(a, b);
    assert.equal(level, 'major');
    assert.ok(reasons.some((r) => r.level === 'major' && r.message.includes('enum introduced')));
  });

  it('regression_anyOf_introduced_on_existing_node_is_major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.anyOf = [{ required: ['metadata'] }, { required: ['name'] }];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('regression_oneOf_introduced_on_existing_node_is_major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.oneOf = [{ const: 'accessibility' }, { const: 'coordinate' }];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('regression_allOf_introduced_on_existing_node_is_major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.allOf = [{ required: ['name'] }];
    assert.equal(classifyChange(a, b).level, 'major');
  });

  it('regression_properties_introduced_on_existing_open_object_is_major', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.metadata = {
      type: 'object',
      properties: { jira: { type: 'string' } },
    };
    const { level, reasons } = classifyChange(a, b);
    assert.equal(level, 'major');
    assert.ok(
      reasons.some((r) => r.level === 'major' && r.message.includes('properties introduced')),
    );
  });

  it('a NEW optional property carrying its own enum stays minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.project.properties.note = { type: 'string', enum: ['a', 'b'] };
    assert.equal(classifyChange(a, b).level, 'minor');
  });

  it('enum value added to an EXISTING enum stays minor', () => {
    const a = baseSchema();
    const b = baseSchema();
    b.$defs.capture_mode.enum = ['accessibility', 'coordinate', 'hybrid'];
    assert.equal(classifyChange(a, b).level, 'minor');
  });
});
