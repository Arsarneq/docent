/**
 * schema-validation.test.js — Extension JSON Schema validation with Ajv.
 *
 * Validates that extension export data conforms to the extension schema
 * (draft 2020-12). The schema is composed from SOURCE LAYERS via
 * composePlatform — never read from schemas/dist/, which is the released
 * artifact and can lag this PR's schema changes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { composePlatform } from '../../../../scripts/build-schemas.js';
import { stampFromSchema } from '../../shared/lib/format-stamp.js';
import { describeElement } from '../../content/recorder-logic.js';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
  resolveActiveSteps,
} from '../../shared/lib/session.js';

const extensionSchema = composePlatform('extension');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateExtension = ajv.compile(extensionSchema);

// The docent_format stamp is read from the schema under test, so these tests
// never need updating when the version bumps.
const stamp = stampFromSchema(extensionSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildExtensionExport(actions = []) {
  const project = createProject('Schema Test');
  const recording = createRecording(project, 'Flow');
  const step = createStep({
    narration: 'Click the button',
    narration_source: 'typed',
    step_number: 1,
    actions,
  });
  addStepRecord(recording, step);
  const steps = resolveActiveSteps(recording);
  return {
    docent_format: stamp,
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
    },
    recordings: [
      {
        recording_id: recording.recording_id,
        name: recording.name,
        created_at: recording.created_at,
        steps: steps.map((s) => ({
          uuid: s.uuid,
          logical_id: s.logical_id,
          step_number: s.step_number,
          created_at: s.created_at,
          narration: s.narration,
          narration_source: s.narration_source,
          actions: s.actions,
          deleted: s.deleted,
        })),
      },
    ],
  };
}

function formatErrors(validate) {
  return (validate.errors || [])
    .map((e) => `${e.instancePath} ${e.message} (${JSON.stringify(e.params)})`)
    .join('\n');
}

// ─── Extension Schema Validation ──────────────────────────────────────────────

describe('Schema validation: extension export', () => {
  it('click action validates against extension schema', () => {
    const data = buildExtensionExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 12345,
        element: {
          tag: 'Button',
          id: null,
          name: null,
          role: null,
          type: null,
          text: 'Submit',
          selector: '#btn',
        },
        x: 100,
        y: 200,
      },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('navigate action validates against extension schema', () => {
    const data = buildExtensionExport([
      {
        type: 'navigate',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 12345,
        url: 'https://example.com',
        nav_type: 'typed',
      },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('type action validates against extension schema', () => {
    const data = buildExtensionExport([
      {
        type: 'type',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 12345,
        element: {
          tag: 'Input',
          id: null,
          name: null,
          role: null,
          type: 'email',
          text: null,
          selector: '#email',
        },
        value: 'test@example.com',
      },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('context_open action validates against extension schema', () => {
    const data = buildExtensionExport([
      {
        type: 'context_open',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 99999,
        source: 'https://example.com',
        opener_context_id: 12345,
      },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('simple mode step (step_type + expect) validates', () => {
    const project = createProject('Simple Mode');
    const recording = createRecording(project, 'Flow');
    const step = createStep({
      step_type: 'validation',
      expect: 'present',
      step_number: 1,
      actions: [
        {
          type: 'click',
          timestamp: Date.now(),
          capture_mode: 'dom',
          context_id: 1,
          element: {
            tag: 'Button',
            id: null,
            name: null,
            role: null,
            type: null,
            text: 'OK',
            selector: '#ok',
          },
          x: 0,
          y: 0,
        },
      ],
    });
    addStepRecord(recording, step);
    const steps = resolveActiveSteps(recording);
    const data = {
      docent_format: stamp,
      project: {
        project_id: project.project_id,
        name: project.name,
        created_at: project.created_at,
      },
      recordings: [
        {
          recording_id: recording.recording_id,
          name: recording.name,
          created_at: recording.created_at,
          steps: steps.map((s) => ({
            uuid: s.uuid,
            logical_id: s.logical_id,
            step_number: s.step_number,
            created_at: s.created_at,
            step_type: s.step_type,
            expect: s.expect,
            actions: s.actions,
            deleted: s.deleted,
          })),
        },
      ],
    };
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('export with metadata validates', () => {
    const data = buildExtensionExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 1,
        element: {
          tag: 'Button',
          id: null,
          name: null,
          role: null,
          type: null,
          text: 'OK',
          selector: '#ok',
        },
        x: 100,
        y: 200,
      },
    ]);
    data.project.metadata = { env: 'production', team: 'QA' };
    data.recordings[0].metadata = { browser: 'Chrome 125' };
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });
});

// ─── locators[] (#174) ────────────────────────────────────────────────────────

function exportWithLocators(locators) {
  return buildExtensionExport([
    {
      type: 'click',
      timestamp: Date.now(),
      capture_mode: 'dom',
      context_id: 1,
      element: {
        tag: 'Button',
        id: null,
        name: null,
        role: null,
        type: null,
        text: 'OK',
        selector: '#ok',
        locators,
      },
      x: 0,
      y: 0,
    },
  ]);
}

describe('Schema validation: extension locators[]', () => {
  it('accepts an element carrying every core strategy shape', () => {
    const data = exportWithLocators([
      { strategy: 'id', value: 'submit-btn', match_count: 1, match_index: 0 },
      {
        strategy: 'test_id',
        attribute: 'data-testid',
        value: 'add-to-cart',
        match_count: 3,
        match_index: 1,
      },
      { strategy: 'role_name', role: 'button', name: 'Add to cart' },
      {
        strategy: 'label',
        mechanism: 'for',
        value: 'Email address',
        match_count: 1,
        match_index: 0,
      },
      {
        strategy: 'css',
        value: 'main > div:nth-of-type(2) > button',
        match_count: 1,
        match_index: null,
      },
      { strategy: 'text', value: '••••••••', masked: true, match_count: 2, match_index: 0 },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('accepts an empty locators array', () => {
    const valid = validateExtension(exportWithLocators([]));
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('closed loop: the real describeElement output validates against the schema', () => {
    // Ties actual capture emission to the contract: what the recorder logic
    // produces for a measurable element must be schema-valid as captured.
    const el = {
      tagName: 'BUTTON',
      id: 'save',
      type: null,
      innerText: '  Save   report ',
      parentElement: null,
      children: [],
      getAttribute: (attr) => ({ 'data-testid': 'save-tid', name: 'save' })[attr] ?? null,
    };
    const doc = {
      body: null,
      querySelectorAll: (sel) =>
        ({
          '#save': [el],
          '[id="save"]': [el],
          '[data-testid="save-tid"]': [el],
          '[name="save"]': [el],
          button: [el],
        })[sel] ?? [],
    };
    el.ownerDocument = doc;

    const element = describeElement(el);
    assert.ok(Array.isArray(element.locators) && element.locators.length >= 5);
    const data = buildExtensionExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 1,
        element,
        x: 10,
        y: 20,
      },
    ]);
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  it('accepts an element without locators (back-compat)', () => {
    const data = exportWithLocators([]);
    delete data.recordings[0].steps[0].actions[0].element.locators;
    const valid = validateExtension(data);
    assert.ok(valid, `Extension schema validation failed:\n${formatErrors(validateExtension)}`);
  });

  const rejects = [
    ['an unknown strategy', { strategy: 'xpath', value: '//button' }],
    ['a desktop-only strategy', { strategy: 'automation_id', value: 'btnSave' }],
    ['match_count of 0', { strategy: 'id', value: 'x', match_count: 0, match_index: 0 }],
    ['a negative match_index', { strategy: 'id', value: 'x', match_count: 1, match_index: -1 }],
    ['an extra property on an entry', { strategy: 'id', value: 'x', confidence: 0.9 }],
    ['a non-boolean masked', { strategy: 'text', value: 'OK', masked: 'yes' }],
    ['test_id without its attribute', { strategy: 'test_id', value: 'save' }],
    ['label without its mechanism', { strategy: 'label', value: 'Email' }],
    [
      'role_name with a stray value field',
      { strategy: 'role_name', role: 'button', name: 'OK', value: 'OK' },
    ],
  ];
  for (const [what, entry] of rejects) {
    it(`rejects ${what}`, () => {
      const valid = validateExtension(exportWithLocators([entry]));
      assert.ok(!valid, `Schema should reject ${what}: ${JSON.stringify(entry)}`);
    });
  }
});

// ─── Negative Tests ───────────────────────────────────────────────────────────

describe('Schema validation: extension negative tests', () => {
  it('rejects missing project field', () => {
    const valid = validateExtension({ recordings: [] });
    assert.ok(!valid, 'Schema should reject data without project field');
  });

  it('rejects missing recordings field', () => {
    const valid = validateExtension({ project: { project_id: 'x', name: 'y', created_at: 'z' } });
    assert.ok(!valid, 'Schema should reject data without recordings field');
  });

  it('rejects step without narration or step_type', () => {
    const data = buildExtensionExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 1,
        element: {
          tag: 'Button',
          id: null,
          name: null,
          role: null,
          type: null,
          text: 'OK',
          selector: '#ok',
        },
      },
    ]);
    delete data.recordings[0].steps[0].narration;
    delete data.recordings[0].steps[0].narration_source;
    const valid = validateExtension(data);
    assert.ok(!valid, 'Schema should reject step without narration or step_type');
  });

  it('rejects additional properties at top level', () => {
    const data = buildExtensionExport([]);
    data.extra_field = 'not allowed';
    const valid = validateExtension(data);
    assert.ok(!valid, 'Schema should reject additional properties at top level');
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe('Schema validation: extension property-based (random valid payloads)', () => {
  // Locator entries: pair generated respecting the documented invariant
  // (match_index < match_count, or null) — executable documentation of #174.
  const matchPairArb = fc.oneof(
    fc.constant({}),
    fc.integer({ min: 1, max: 50 }).chain((count) =>
      fc.record({
        match_count: fc.constant(count),
        match_index: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: count - 1 })),
      }),
    ),
  );
  const extensionLocatorArb = fc
    .oneof(
      fc.record({ strategy: fc.constant('id'), value: fc.string({ minLength: 1 }) }),
      fc.record({
        strategy: fc.constant('test_id'),
        attribute: fc.constantFrom('data-testid', 'data-test', 'data-qa', 'data-cy'),
        value: fc.string({ minLength: 1 }),
      }),
      fc.record({
        strategy: fc.constant('role_name'),
        role: fc.constantFrom('button', 'textbox', 'link'),
        name: fc.string({ minLength: 1 }),
      }),
      fc.record({
        strategy: fc.constant('label'),
        mechanism: fc.constantFrom('for', 'wrapped', 'aria-labelledby'),
        value: fc.string({ minLength: 1 }),
      }),
      fc.record({
        strategy: fc.constant('text'),
        value: fc.string({ minLength: 1, maxLength: 100 }),
        masked: fc.boolean(),
      }),
      fc.record({ strategy: fc.constant('css'), value: fc.string({ minLength: 1 }) }),
    )
    .chain((entry) => matchPairArb.map((pair) => ({ ...entry, ...pair })));

  const actionArb = fc.oneof(
    fc.record({
      type: fc.constant('click'),
      timestamp: fc.nat(),
      capture_mode: fc.constant('dom'),
      context_id: fc.nat(),
      element: fc.record(
        {
          tag: fc.constantFrom('Button', 'A', 'Input', 'Div', 'Span'),
          id: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          name: fc.constant(null),
          role: fc.constant(null),
          type: fc.constant(null),
          text: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          selector: fc.string(),
          locators: fc.array(extensionLocatorArb, { maxLength: 4 }),
        },
        { requiredKeys: ['tag', 'id', 'name', 'role', 'type', 'text', 'selector'] },
      ),
      x: fc.integer(),
      y: fc.integer(),
    }),
    fc.record({
      type: fc.constant('type'),
      timestamp: fc.nat(),
      capture_mode: fc.constant('dom'),
      context_id: fc.nat(),
      element: fc.record({
        tag: fc.constant('Input'),
        id: fc.constant(null),
        name: fc.constant(null),
        role: fc.constant(null),
        type: fc.constant(null),
        text: fc.constant(null),
        selector: fc.string(),
      }),
      value: fc.string(),
    }),
    fc.record({
      type: fc.constant('scroll'),
      timestamp: fc.nat(),
      capture_mode: fc.constant('dom'),
      context_id: fc.nat(),
      element: fc.constant(null),
      scroll_top: fc.integer(),
      scroll_left: fc.integer(),
      delta_y: fc.integer(),
      delta_x: fc.integer(),
    }),
  );

  it('100 random extension payloads all validate', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 1, maxLength: 5 }), (actions) => {
        const data = buildExtensionExport(actions);
        const valid = validateExtension(data);
        if (!valid) {
          throw new Error(
            `Validation failed:\n${formatErrors(validateExtension)}\nData: ${JSON.stringify(data, null, 2).slice(0, 500)}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});
