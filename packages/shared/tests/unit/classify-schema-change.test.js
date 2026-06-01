/**
 * classify-schema-change.test.js — Unit tests for the mechanical schema-change
 * classifier that drives auto-versioning. Each test encodes one rule from
 * docs/session-format.md (patch/minor/major) plus the conservative
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
