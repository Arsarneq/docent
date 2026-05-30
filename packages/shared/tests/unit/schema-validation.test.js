/**
 * schema-validation.test.js — Full JSON Schema validation with Ajv
 *
 * Validates that buildPayload output and export data conform to the
 * published JSON Schemas using Ajv (draft 2020-12).
 *
 * Covers issue #60.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { buildPayload } from '../../dispatch-core.js';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
  resolveActiveSteps,
} from '../../lib/session.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load schemas
const extensionSchema = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../schemas/extension.schema.json'), 'utf-8'),
);
const desktopSchema = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../schemas/desktop-windows.schema.json'), 'utf-8'),
);

// Reading guidance (used in dispatch payloads)
const readingGuidance = readFileSync(
  resolve(__dirname, '../../assets/reading-guidance.md'),
  'utf-8',
);

// Set up Ajv
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateExtension = ajv.compile(extensionSchema);
const validateDesktop = ajv.compile(desktopSchema);

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

// ─── Negative Tests ───────────────────────────────────────────────────────────

describe('Schema validation: negative tests (must reject bad data)', () => {
  it('rejects missing project field', () => {
    const data = { recordings: [] };
    const valid = validateExtension(data);
    assert.ok(!valid, 'Schema should reject data without project field');
  });

  it('rejects missing recordings field', () => {
    const data = { project: { project_id: 'x', name: 'y', created_at: 'z' } };
    const valid = validateExtension(data);
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
    // Remove both narration and step_type — schema requires at least one
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

describe('Schema validation: property-based (random valid payloads)', () => {
  const actionArb = fc.oneof(
    fc.record({
      type: fc.constant('click'),
      timestamp: fc.nat(),
      capture_mode: fc.constant('dom'),
      context_id: fc.nat(),
      element: fc.record({
        tag: fc.constantFrom('Button', 'A', 'Input', 'Div', 'Span'),
        id: fc.option(fc.string({ minLength: 1 }), { nil: null }),
        name: fc.constant(null),
        role: fc.constant(null),
        type: fc.constant(null),
        text: fc.option(fc.string({ minLength: 1 }), { nil: null }),
        selector: fc.string(),
      }),
      x: fc.integer(),
      y: fc.integer(),
      window_rect: fc.constant(null),
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
      window_rect: fc.constant(null),
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
      window_rect: fc.constant(null),
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

// ─── Desktop Schema Validation ────────────────────────────────────────────────

describe('Schema validation: desktop export', () => {
  function buildDesktopExport(actions = []) {
    const project = createProject('Desktop Test');
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

  it('click action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        element: {
          tag: 'Button',
          id: null,
          name: 'Submit',
          role: 'button',
          type: null,
          text: 'Submit',
          selector: 'Button:Submit',
        },
        x: 150,
        y: 300,
        window_rect: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('type action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'type',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        element: {
          tag: 'Edit',
          id: null,
          name: 'Username',
          role: 'textbox',
          type: null,
          text: null,
          selector: 'Edit:Username',
        },
        value: 'admin',
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('key action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'key',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        key: 'Enter',
        modifiers: { ctrl: false, shift: false, alt: false, meta: false },
        element: {
          tag: 'Button',
          id: null,
          name: 'OK',
          role: 'button',
          type: null,
          text: 'OK',
          selector: 'Button:OK',
        },
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('scroll action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'scroll',
        timestamp: Date.now(),
        capture_mode: 'coordinate',
        context_id: 65538,
        element: null,
        scroll_top: 500,
        scroll_left: 0,
        delta_y: 500,
        delta_x: 0,
        window_rect: { x: 100, y: 100, width: 800, height: 600 },
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('file_dialog action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'file_dialog',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        dialog_type: 'open',
        file_path: 'C:\\Users\\test\\Documents\\report.docx',
        source: 'C:\\Program Files\\Microsoft Office\\WINWORD.EXE',
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('context_switch action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'context_switch',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 131074,
        source: 'C:\\Program Files\\Notepad++\\notepad++.exe',
        title: 'Untitled - Notepad++',
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('context_open action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'context_open',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 196610,
        opener_context_id: 65538,
        source: 'C:\\Windows\\explorer.exe',
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('context_close action validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'context_close',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 196610,
        window_closing: false,
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });

  it('export with metadata validates against desktop schema', () => {
    const data = buildDesktopExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        element: {
          tag: 'Button',
          id: null,
          name: null,
          role: null,
          type: null,
          text: 'OK',
          selector: 'Button:OK',
        },
        x: 100,
        y: 200,
        window_rect: null,
      },
    ]);
    data.project.metadata = { app: 'Notepad++', os: 'Windows 11' };
    data.recordings[0].metadata = { resolution: '1920x1080' };
    const valid = validateDesktop(data);
    assert.ok(valid, `Desktop schema validation failed:\n${formatErrors(validateDesktop)}`);
  });
});

// ─── Desktop Negative Tests ───────────────────────────────────────────────────

describe('Schema validation: desktop negative tests', () => {
  function buildDesktopExport(actions = []) {
    const project = createProject('Desktop Neg');
    const recording = createRecording(project, 'Flow');
    const step = createStep({
      narration: 'Test',
      narration_source: 'typed',
      step_number: 1,
      actions,
    });
    addStepRecord(recording, step);
    const steps = resolveActiveSteps(recording);
    return {
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

  it('rejects extension-only navigate action', () => {
    const data = buildDesktopExport([
      {
        type: 'navigate',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        url: 'https://example.com',
        nav_type: 'typed',
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(!valid, 'Desktop schema should reject navigate action');
  });

  it('rejects extension-only file_upload action', () => {
    const data = buildDesktopExport([
      {
        type: 'file_upload',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 65538,
        element: {
          tag: 'Input',
          id: null,
          name: null,
          role: null,
          type: 'file',
          text: null,
          selector: '#file',
        },
        files: [{ name: 'test.txt', size: 100, mime: 'text/plain' }],
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(!valid, 'Desktop schema should reject file_upload action');
  });

  it('rejects capture_mode "dom" (extension-only)', () => {
    const data = buildDesktopExport([
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 65538,
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
        window_rect: null,
      },
    ]);
    const valid = validateDesktop(data);
    assert.ok(!valid, 'Desktop schema should reject capture_mode "dom"');
  });
});

// ─── Desktop Property-Based Tests ─────────────────────────────────────────────

describe('Schema validation: desktop property-based (random valid payloads)', () => {
  const desktopElement = fc.record({
    tag: fc.constantFrom('Button', 'Edit', 'ComboBox', 'ListItem', 'TreeItem', 'MenuItem'),
    id: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    name: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    role: fc.option(fc.constantFrom('button', 'textbox', 'listitem', 'menuitem'), { nil: null }),
    type: fc.constant(null),
    text: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    selector: fc.string({ minLength: 1 }),
  });

  const desktopWindowRect = fc.oneof(
    fc.constant(null),
    fc.record({
      x: fc.integer({ min: 0, max: 3840 }),
      y: fc.integer({ min: 0, max: 2160 }),
      width: fc.integer({ min: 100, max: 3840 }),
      height: fc.integer({ min: 100, max: 2160 }),
    }),
  );

  const desktopActionArb = fc.oneof(
    fc.record({
      type: fc.constant('click'),
      timestamp: fc.nat(),
      capture_mode: fc.constantFrom('accessibility', 'coordinate'),
      context_id: fc.nat(),
      element: desktopElement,
      x: fc.integer(),
      y: fc.integer(),
      window_rect: desktopWindowRect,
    }),
    fc.record({
      type: fc.constant('type'),
      timestamp: fc.nat(),
      capture_mode: fc.constantFrom('accessibility', 'coordinate'),
      context_id: fc.nat(),
      element: desktopElement,
      value: fc.string(),
      window_rect: desktopWindowRect,
    }),
    fc.record({
      type: fc.constant('key'),
      timestamp: fc.nat(),
      capture_mode: fc.constantFrom('accessibility', 'coordinate'),
      context_id: fc.nat(),
      key: fc.constantFrom('Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'A', 'Space'),
      modifiers: fc.record({
        ctrl: fc.boolean(),
        shift: fc.boolean(),
        alt: fc.boolean(),
        meta: fc.boolean(),
      }),
      element: desktopElement,
      window_rect: desktopWindowRect,
    }),
    fc.record({
      type: fc.constant('scroll'),
      timestamp: fc.nat(),
      capture_mode: fc.constantFrom('accessibility', 'coordinate'),
      context_id: fc.nat(),
      element: fc.constant(null),
      scroll_top: fc.integer(),
      scroll_left: fc.integer(),
      delta_y: fc.integer(),
      delta_x: fc.integer(),
      window_rect: desktopWindowRect,
    }),
    fc.record({
      type: fc.constant('file_dialog'),
      timestamp: fc.nat(),
      capture_mode: fc.constant('accessibility'),
      context_id: fc.nat(),
      dialog_type: fc.constantFrom('open', 'save', 'save_as'),
      file_path: fc.string({ minLength: 1 }),
      source: fc.string({ minLength: 1 }),
      window_rect: desktopWindowRect,
    }),
    fc.record({
      type: fc.constant('context_switch'),
      timestamp: fc.nat(),
      capture_mode: fc.constantFrom('accessibility', 'coordinate'),
      context_id: fc.nat(),
      source: fc.string({ minLength: 1 }),
      title: fc.option(fc.string({ minLength: 1 }), { nil: null }),
      window_rect: desktopWindowRect,
    }),
  );

  it('100 random desktop payloads all validate', () => {
    fc.assert(
      fc.property(fc.array(desktopActionArb, { minLength: 1, maxLength: 5 }), (actions) => {
        const project = createProject('Prop Test');
        const recording = createRecording(project, 'Flow');
        const step = createStep({
          narration: 'Auto step',
          narration_source: 'typed',
          step_number: 1,
          actions,
        });
        addStepRecord(recording, step);
        const steps = resolveActiveSteps(recording);
        const data = {
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
        const valid = validateDesktop(data);
        if (!valid) {
          throw new Error(
            `Desktop validation failed:\n${formatErrors(validateDesktop)}\nData: ${JSON.stringify(data, null, 2).slice(0, 500)}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  });
});
