/**
 * Property 8: Duplicate import produces distinct copy
 * Property 9: Invalid import rejection
 *
 * Property 8: For any valid `.docent.json` file whose `project_id`
 * matches an existing project in the local store, importing the file
 * SHALL produce a new project with a `project_id` different from the
 * original and a `name` that ends with `" (copy)"`.
 *
 * **Validates: Requirements 8.2**
 *
 * Property 9: For any JSON string that does not conform to the
 * Schema_Contract (missing required fields, wrong types, invalid
 * structure), attempting to import it SHALL be rejected with a
 * descriptive error message, and the local project list SHALL remain
 * unchanged.
 *
 * **Validates: Requirements 8.3**
 *
 * This tests the pure import logic, not the Tauri invoke calls.
 *
 * Feature: desktop-capture, Property 8: Duplicate import produces distinct copy
 * Feature: desktop-capture, Property 9: Invalid import rejection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// ─── Pure import logic (replicated from panel.js handleImportData) ────────────

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

let uuidCounter = 0;

/**
 * Generate a deterministic UUIDv7-like string for testing.
 * In production this uses the real uuidv7() from shared/lib/uuid-v7.js.
 */
function testUuidv7() {
  uuidCounter++;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  const ts = Date.now().toString(16).padStart(12, '0');
  // Build a valid UUIDv7: 8-4-4-4-12
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7000-8000-${hex}`;
}

/**
 * Validates that an export data object conforms to the basic schema contract.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateImportData(exportData) {
  if (!exportData || typeof exportData !== 'object') {
    return { valid: false, error: 'Import data must be a JSON object.' };
  }
  if (!exportData.project || typeof exportData.project !== 'object') {
    return { valid: false, error: 'Missing or invalid "project" field.' };
  }
  const p = exportData.project;
  if (typeof p.project_id !== 'string' || !UUIDV7_RE.test(p.project_id)) {
    return { valid: false, error: 'Invalid or missing project_id (must be UUIDv7).' };
  }
  if (typeof p.name !== 'string') {
    return { valid: false, error: 'Invalid or missing project name.' };
  }
  if (typeof p.created_at !== 'string' || !ISO8601_RE.test(p.created_at)) {
    return { valid: false, error: 'Invalid or missing project created_at (must be ISO 8601).' };
  }
  if (!Array.isArray(exportData.recordings)) {
    return { valid: false, error: 'Missing or invalid "recordings" array.' };
  }
  for (let i = 0; i < exportData.recordings.length; i++) {
    const r = exportData.recordings[i];
    if (!r || typeof r !== 'object') {
      return { valid: false, error: `Recording at index ${i} is not an object.` };
    }
    if (typeof r.recording_id !== 'string' || !UUIDV7_RE.test(r.recording_id)) {
      return { valid: false, error: `Recording at index ${i} has invalid recording_id.` };
    }
    if (typeof r.name !== 'string') {
      return { valid: false, error: `Recording at index ${i} has invalid name.` };
    }
  }
  return { valid: true };
}

/**
 * Handles importing export data into a local project list.
 * Returns { success: true, projects } or { success: false, error }.
 *
 * This replicates the pure logic from panel.js handleImportData.
 */
function handleImport(existingProjects, exportData) {
  // Validate
  const validation = validateImportData(exportData);
  if (!validation.valid) {
    return { success: false, error: validation.error, projects: [...existingProjects] };
  }

  const imported = exportData.project;
  const exists = existingProjects.some(p => p.project_id === imported.project_id);

  const newProject = {
    project_id: exists ? testUuidv7() : imported.project_id,
    name: exists ? `${imported.name} (copy)` : imported.name,
    created_at: imported.created_at ?? new Date().toISOString(),
    recordings: (exportData.recordings ?? []).map(r => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: (r.steps ?? []).map(s => ({
        uuid: s.uuid ?? testUuidv7(),
        logical_id: s.logical_id,
        step_number: s.step_number,
        created_at: s.created_at,
        ...(s.narration && { narration: s.narration }),
        ...(s.narration_source && { narration_source: s.narration_source }),
        ...(s.step_type && { step_type: s.step_type }),
        ...(s.expect && { expect: s.expect }),
        actions: s.actions ?? [],
        deleted: s.deleted ?? false,
      })),
    })),
  };

  const updatedProjects = [...existingProjects, newProject];
  return { success: true, projects: updatedProjects };
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
  tag: fc.constantFrom('BUTTON', 'INPUT', 'A', 'DIV'),
  id: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 20 })),
  name: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 30 })),
  role: fc.oneof(fc.constant(null), fc.constantFrom('button', 'textbox')),
  type: fc.oneof(fc.constant(null), fc.constantFrom('text', 'submit')),
  text: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 50 })),
  selector: fc.string({ minLength: 1, maxLength: 50 }),
});

const arbAction = fc.record({
  type: fc.constant('click'),
  timestamp: fc.integer({ min: 1000000000000, max: 9999999999999 }),
  x: fc.double({ min: 0, max: 2000, noNaN: true }),
  y: fc.double({ min: 0, max: 2000, noNaN: true }),
  element: arbElement,
  context_id: fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.constant(null)),
  capture_mode: fc.constantFrom('dom', 'accessibility', 'coordinate'),
  window_rect: fc.constant(null),
  frame_src: fc.constant(null),
});

const arbNarrationStep = fc.record({
  uuid: arbUuid,
  logical_id: arbUuid,
  step_number: fc.integer({ min: 1, max: 100 }),
  created_at: arbTimestamp,
  narration: fc.string({ minLength: 1, maxLength: 200 }),
  narration_source: fc.constant('typed'),
  actions: fc.array(arbAction, { minLength: 0, maxLength: 3 }),
  deleted: fc.constant(false),
});

const arbSimpleStep = fc.record({
  uuid: arbUuid,
  logical_id: arbUuid,
  step_number: fc.integer({ min: 1, max: 100 }),
  created_at: arbTimestamp,
  step_type: fc.constantFrom('action', 'validation'),
  expect: fc.option(fc.constantFrom('present', 'absent'), { nil: undefined }),
  actions: fc.array(arbAction, { minLength: 0, maxLength: 3 }),
  deleted: fc.constant(false),
});

const arbStep = fc.oneof(arbNarrationStep, arbSimpleStep);

const arbRecording = fc.record({
  recording_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  steps: fc.array(arbStep, { minLength: 0, maxLength: 3 }),
});

/** Generate a valid export data object */
const arbExportData = fc.record({
  project: fc.record({
    project_id: arbUuid,
    name: fc.string({ minLength: 1, maxLength: 100 }),
    created_at: arbTimestamp,
  }),
  recordings: fc.array(arbRecording, { minLength: 0, maxLength: 3 }),
});

/** Generate a local project (same shape as what's stored in sessionState) */
const arbLocalProject = fc.record({
  project_id: arbUuid,
  name: fc.string({ minLength: 1, maxLength: 100 }),
  created_at: arbTimestamp,
  recordings: fc.array(arbRecording, { minLength: 0, maxLength: 2 }),
});

// ─── Property 8: Duplicate import produces distinct copy ──────────────────────

describe('Property 8: Duplicate import produces distinct copy', () => {
  it('importing a project with matching project_id produces a new project with different ID and "(copy)" suffix', () => {
    fc.assert(
      fc.property(
        arbExportData,
        arbLocalProject,
        (exportData, localProject) => {
          // Force the local project to have the same project_id as the import
          localProject.project_id = exportData.project.project_id;
          const existingProjects = [localProject];

          // Reset counter for deterministic UUIDs
          uuidCounter = 0;

          const result = handleImport(existingProjects, exportData);

          assert.strictEqual(result.success, true, 'Import should succeed');
          assert.strictEqual(result.projects.length, 2,
            'Should have original + imported project');

          const importedProject = result.projects[1];

          // project_id must be different from the original
          assert.notStrictEqual(importedProject.project_id, exportData.project.project_id,
            'Imported project must have a different project_id');

          // name must end with " (copy)"
          assert.ok(importedProject.name.endsWith(' (copy)'),
            `Imported project name "${importedProject.name}" must end with " (copy)"`);

          // name should be original name + " (copy)"
          assert.strictEqual(importedProject.name, `${exportData.project.name} (copy)`,
            'Imported project name should be original name + " (copy)"');

          // Original project should be unchanged
          assert.strictEqual(result.projects[0].project_id, localProject.project_id);
          assert.strictEqual(result.projects[0].name, localProject.name);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('importing a project with non-matching project_id preserves the original ID', () => {
    fc.assert(
      fc.property(
        arbExportData,
        arbLocalProject,
        (exportData, localProject) => {
          // Ensure IDs are different
          if (localProject.project_id === exportData.project.project_id) return;

          const existingProjects = [localProject];
          const result = handleImport(existingProjects, exportData);

          assert.strictEqual(result.success, true, 'Import should succeed');
          const importedProject = result.projects[1];

          // project_id should be preserved (no duplicate)
          assert.strictEqual(importedProject.project_id, exportData.project.project_id,
            'Non-duplicate import should preserve project_id');

          // name should not have "(copy)" suffix
          assert.strictEqual(importedProject.name, exportData.project.name,
            'Non-duplicate import should preserve original name');
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 9: Invalid import rejection ─────────────────────────────────────

describe('Property 9: Invalid import rejection', () => {
  it('malformed JSON structures are rejected with a descriptive error', () => {
    // Generate various kinds of invalid import data
    const arbMalformed = fc.oneof(
      // Missing project entirely
      fc.record({
        recordings: fc.array(arbRecording, { minLength: 0, maxLength: 2 }),
      }),
      // project is not an object
      fc.record({
        project: fc.oneof(fc.constant(null), fc.constant(42), fc.constant('string')),
        recordings: fc.constant([]),
      }),
      // project missing project_id
      fc.record({
        project: fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: arbTimestamp,
        }),
        recordings: fc.constant([]),
      }),
      // project_id is not a valid UUIDv7
      fc.record({
        project: fc.record({
          project_id: fc.string({ minLength: 1, maxLength: 20 }).filter(s => !UUIDV7_RE.test(s)),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: arbTimestamp,
        }),
        recordings: fc.constant([]),
      }),
      // recordings is not an array
      fc.record({
        project: fc.record({
          project_id: arbUuid,
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: arbTimestamp,
        }),
        recordings: fc.oneof(fc.constant(null), fc.constant('not-array'), fc.constant(42)),
      }),
      // project name is not a string
      fc.record({
        project: fc.record({
          project_id: arbUuid,
          name: fc.oneof(fc.constant(null), fc.constant(42), fc.constant(true)),
          created_at: arbTimestamp,
        }),
        recordings: fc.constant([]),
      }),
      // created_at is not ISO 8601
      fc.record({
        project: fc.record({
          project_id: arbUuid,
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: fc.string({ minLength: 1, maxLength: 10 }).filter(s => !ISO8601_RE.test(s)),
        }),
        recordings: fc.constant([]),
      }),
      // completely random non-object values
      fc.oneof(
        fc.constant(null),
        fc.constant(42),
        fc.constant('just a string'),
        fc.constant(true),
        fc.constant([]),
      ),
    );

    fc.assert(
      fc.property(
        arbMalformed,
        fc.array(arbLocalProject, { minLength: 0, maxLength: 3 }),
        (malformedData, existingProjects) => {
          const originalCount = existingProjects.length;
          const originalIds = existingProjects.map(p => p.project_id);

          const result = handleImport(existingProjects, malformedData);

          // Import must be rejected
          assert.strictEqual(result.success, false,
            `Import should be rejected for malformed data: ${JSON.stringify(malformedData)}`);

          // Error message must be descriptive (non-empty string)
          assert.strictEqual(typeof result.error, 'string', 'Error must be a string');
          assert.ok(result.error.length > 0, 'Error message must be non-empty');

          // Local project list must be unchanged
          assert.strictEqual(result.projects.length, originalCount,
            'Project list length must not change on rejected import');
          const resultIds = result.projects.map(p => p.project_id);
          assert.deepStrictEqual(resultIds, originalIds,
            'Project IDs must not change on rejected import');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('recordings with invalid recording_id are rejected', () => {
    const arbInvalidRecording = fc.record({
      project: fc.record({
        project_id: arbUuid,
        name: fc.string({ minLength: 1, maxLength: 50 }),
        created_at: arbTimestamp,
      }),
      recordings: fc.array(
        fc.record({
          recording_id: fc.string({ minLength: 1, maxLength: 20 }).filter(s => !UUIDV7_RE.test(s)),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          created_at: arbTimestamp,
          steps: fc.constant([]),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    });

    fc.assert(
      fc.property(
        arbInvalidRecording,
        fc.array(arbLocalProject, { minLength: 0, maxLength: 2 }),
        (invalidData, existingProjects) => {
          const originalCount = existingProjects.length;

          const result = handleImport(existingProjects, invalidData);

          assert.strictEqual(result.success, false,
            'Import should be rejected for invalid recording_id');
          assert.strictEqual(typeof result.error, 'string');
          assert.ok(result.error.length > 0);
          assert.strictEqual(result.projects.length, originalCount,
            'Project list must not change');
        },
      ),
      { numRuns: 100 },
    );
  });
});
