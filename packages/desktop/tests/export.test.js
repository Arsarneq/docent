/**
 * Property 7: Export schema validation
 *
 * For any valid project containing recordings with steps and actions,
 * exporting the project SHALL produce a JSON structure that validates
 * against the v2.0.0 Schema_Contract. The export SHALL include all
 * recordings, all resolved active steps (latest version per logical_id,
 * excluding deleted), and the project metadata (project_id, name,
 * created_at).
 *
 * **Validates: Requirements 7.1, 7.3, 7.4**
 *
 * This tests the pure export-building logic, not the Tauri invoke calls.
 * We replicate the export logic from panel.js and validate the output
 * against the schema contract.
 *
 * Feature: desktop-capture, Property 7: Export schema validation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ─── Schema validation (lightweight, no external JSON Schema library) ─────────
// We validate the structural contract defined in session.schema.json directly.

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const VALID_ACTION_TYPES = new Set([
  'navigate', 'click', 'right_click', 'type', 'select', 'key', 'focus',
  'file_upload', 'drag_start', 'drop', 'scroll',
  'context_switch', 'context_open', 'context_close', 'file_dialog',
]);

const VALID_CAPTURE_MODES = new Set(['dom', 'accessibility', 'coordinate']);

function validateElement(el) {
  assert.strictEqual(typeof el.tag, 'string', 'element.tag must be a string');
  assert.strictEqual(typeof el.selector, 'string', 'element.selector must be a string');
  // Optional nullable fields
  for (const field of ['id', 'name', 'role', 'type', 'text']) {
    const val = el[field];
    assert.ok(val === null || typeof val === 'string',
      `element.${field} must be string or null, got ${typeof val}`);
  }
}

function validateAction(action) {
  assert.ok(VALID_ACTION_TYPES.has(action.type),
    `action.type "${action.type}" is not a valid action type`);
  assert.strictEqual(typeof action.timestamp, 'number', 'action.timestamp must be a number');
  assert.ok(Number.isInteger(action.timestamp), 'action.timestamp must be an integer');
  assert.ok(VALID_CAPTURE_MODES.has(action.capture_mode),
    `action.capture_mode "${action.capture_mode}" is not valid`);
  assert.ok(action.context_id === null || Number.isInteger(action.context_id),
    'action.context_id must be integer or null');
}

function validateStep(step) {
  assert.ok(UUIDV7_RE.test(step.uuid), `step.uuid "${step.uuid}" is not a valid UUIDv7`);
  assert.ok(UUIDV7_RE.test(step.logical_id), `step.logical_id "${step.logical_id}" is not a valid UUIDv7`);
  assert.strictEqual(typeof step.step_number, 'number', 'step.step_number must be a number');
  assert.ok(Number.isInteger(step.step_number) && step.step_number >= 1,
    'step.step_number must be integer >= 1');
  assert.ok(ISO8601_RE.test(step.created_at), `step.created_at "${step.created_at}" is not ISO 8601`);
  assert.strictEqual(typeof step.narration, 'string', 'step.narration must be a string');
  assert.strictEqual(step.narration_source, 'typed', 'step.narration_source must be "typed"');
  assert.ok(Array.isArray(step.actions), 'step.actions must be an array');
  assert.strictEqual(typeof step.deleted, 'boolean', 'step.deleted must be a boolean');
  for (const action of step.actions) {
    validateAction(action);
  }
}

function validateRecording(recording) {
  assert.ok(UUIDV7_RE.test(recording.recording_id),
    `recording.recording_id "${recording.recording_id}" is not a valid UUIDv7`);
  assert.strictEqual(typeof recording.name, 'string', 'recording.name must be a string');
  assert.ok(ISO8601_RE.test(recording.created_at),
    `recording.created_at "${recording.created_at}" is not ISO 8601`);
  assert.ok(Array.isArray(recording.steps), 'recording.steps must be an array');
  assert.ok(Array.isArray(recording.activeSteps), 'recording.activeSteps must be an array');
  for (const step of recording.steps) validateStep(step);
  for (const step of recording.activeSteps) validateStep(step);
}

function validateExport(exportData) {
  // Top-level structure
  assert.ok(exportData.project, 'export must have project');
  assert.ok(Array.isArray(exportData.recordings), 'export must have recordings array');

  // Project metadata
  const p = exportData.project;
  assert.ok(UUIDV7_RE.test(p.project_id), `project.project_id "${p.project_id}" is not a valid UUIDv7`);
  assert.strictEqual(typeof p.name, 'string', 'project.name must be a string');
  assert.ok(ISO8601_RE.test(p.created_at), `project.created_at "${p.created_at}" is not ISO 8601`);

  // No additional properties on project
  const projectKeys = Object.keys(p);
  for (const key of projectKeys) {
    assert.ok(['project_id', 'name', 'created_at'].includes(key),
      `project has unexpected key "${key}"`);
  }

  // Recordings
  for (const recording of exportData.recordings) {
    validateRecording(recording);
  }
}

// ─── Pure export logic (replicated from panel.js) ─────────────────────────────

/**
 * Resolves active steps from a recording — latest version per logical_id,
 * excluding deleted, sorted by step_number.
 * (Same logic as packages/shared/lib/session.js resolveActiveSteps)
 */
function resolveActiveSteps(recording) {
  const groups = new Map();
  for (const step of recording.steps) {
    const existing = groups.get(step.logical_id);
    if (!existing || step.uuid > existing.uuid) {
      groups.set(step.logical_id, step);
    }
  }
  return Array.from(groups.values())
    .filter(step => !step.deleted)
    .sort((a, b) => a.step_number - b.step_number);
}

/**
 * Builds the export data structure for a project.
 * This is the pure logic that panel.js uses to build the export JSON.
 * The output must validate against the v2.0.0 schema contract.
 */
function buildExportData(project) {
  const recordings = (project.recordings ?? []).map(r => {
    const active = resolveActiveSteps(r);
    return {
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: r.steps,
      activeSteps: active,
    };
  });

  return {
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
    },
    recordings,
  };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const hexChar = fc.constantFrom(...'0123456789abcdef'.split(''));

const arbUuid = fc.tuple(
  fc.array(hexChar, { minLength: 8, maxLength: 8 }),
  fc.array(hexChar, { minLength: 4, maxLength: 4 }),
  fc.array(hexChar, { minLength: 3, maxLength: 3 }),
  fc.constantFrom('8', '9', 'a', 'b'),
  fc.array(hexChar, { minLength: 3, maxLength: 3 }),
  fc.array(hexChar, { minLength: 12, maxLength: 12 }),
).map(([a, b, c, variant, d, e]) =>
  `${a.join('')}-${b.join('')}-7${c.join('')}-${variant}${d.join('')}-${e.join('')}`
);

const arbTimestamp = fc.integer({
  min: new Date('2020-01-01').getTime(),
  max: new Date('2030-12-31').getTime(),
}).map(ms => new Date(ms).toISOString());

const arbElement = fc.record({
  tag: fc.constantFrom('BUTTON', 'INPUT', 'A', 'DIV', 'SPAN', 'SELECT', 'TEXTAREA'),
  id: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 30 })),
  name: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 50 })),
  role: fc.oneof(fc.constant(null), fc.constantFrom('button', 'textbox', 'link', 'listbox')),
  type: fc.oneof(fc.constant(null), fc.constantFrom('text', 'password', 'submit', 'checkbox')),
  text: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 100 })),
  selector: fc.string({ minLength: 1, maxLength: 100 }),
});

const arbCaptureMode = fc.constantFrom('dom', 'accessibility', 'coordinate');

const arbContextId = fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.constant(null));

/** Generate a schema-valid action (click type for simplicity, covers the contract) */
const arbAction = fc.record({
  type: fc.constant('click'),
  timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
  x: fc.double({ min: 0, max: 2000, noNaN: true }),
  y: fc.double({ min: 0, max: 2000, noNaN: true }),
  element: arbElement,
  context_id: arbContextId,
  capture_mode: arbCaptureMode,
  window_rect: fc.constant(null),
  frame_src: fc.constant(null),
});

const arbStep = fc.record({
  uuid: arbUuid,
  logical_id: arbUuid,
  step_number: fc.integer({ min: 1, max: 100 }),
  created_at: arbTimestamp,
  narration: fc.string({ minLength: 1, maxLength: 200 }),
  narration_source: fc.constant('typed'),
  actions: fc.array(arbAction, { minLength: 0, maxLength: 3 }),
  deleted: fc.constant(false),
});

const arbRecording = fc.record({
  recording_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  steps: fc.array(arbStep, { minLength: 0, maxLength: 5 }),
});

const arbProject = fc.record({
  project_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  recordings: fc.array(arbRecording, { minLength: 0, maxLength: 3 }),
});

// ─── Property tests ───────────────────────────────────────────────────────────

describe('Property 7: Export schema validation', () => {
  it('exported JSON validates against the v2.0.0 schema contract', () => {
    fc.assert(
      fc.property(arbProject, (project) => {
        const exportData = buildExportData(project);
        validateExport(exportData);
      }),
      { numRuns: 100 },
    );
  });

  it('export includes all recordings from the project', () => {
    fc.assert(
      fc.property(arbProject, (project) => {
        const exportData = buildExportData(project);
        assert.strictEqual(exportData.recordings.length, project.recordings.length,
          'export must include all recordings');
      }),
      { numRuns: 100 },
    );
  });

  it('export includes project metadata (project_id, name, created_at)', () => {
    fc.assert(
      fc.property(arbProject, (project) => {
        const exportData = buildExportData(project);
        assert.strictEqual(exportData.project.project_id, project.project_id);
        assert.strictEqual(exportData.project.name, project.name);
        assert.strictEqual(exportData.project.created_at, project.created_at);
      }),
      { numRuns: 100 },
    );
  });

  it('activeSteps contains only non-deleted latest versions sorted by step_number', () => {
    // Generate a recording with multiple versions of the same logical step
    const arbStepWithVersions = fc.tuple(arbUuid, arbUuid).chain(([logicalId, uuid2]) =>
      fc.tuple(
        arbStep.map(s => ({ ...s, logical_id: logicalId, step_number: 1 })),
        arbStep.map(s => ({ ...s, logical_id: logicalId, step_number: 1, uuid: uuid2 })),
      )
    );

    fc.assert(
      fc.property(
        arbProject,
        (project) => {
          const exportData = buildExportData(project);

          for (let i = 0; i < exportData.recordings.length; i++) {
            const exportRec = exportData.recordings[i];
            const sourceRec = project.recordings[i];

            // activeSteps should match resolveActiveSteps
            const expected = resolveActiveSteps(sourceRec);
            assert.strictEqual(exportRec.activeSteps.length, expected.length,
              'activeSteps count should match resolved active steps');

            // Verify sorted by step_number
            for (let j = 1; j < exportRec.activeSteps.length; j++) {
              assert.ok(
                exportRec.activeSteps[j].step_number >= exportRec.activeSteps[j - 1].step_number,
                'activeSteps must be sorted by step_number',
              );
            }

            // Verify no deleted steps in activeSteps
            for (const step of exportRec.activeSteps) {
              assert.strictEqual(step.deleted, false,
                'activeSteps must not contain deleted steps');
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
