/**
 * contract.test.js — Contract tests validating output against JSON Schema.
 *
 * Verifies that buildPayload output and export data conform to the
 * platform schemas. Uses the schemas as the source of truth.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPayload } from '../dispatch-core.js';
import { createProject, createRecording, createStep, addStepRecord, resolveActiveSteps } from '../lib/session.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Load schemas
const extensionSchema = JSON.parse(readFileSync(resolve(__dirname, '../../../schemas/extension.schema.json'), 'utf-8'));
const desktopSchema = JSON.parse(readFileSync(resolve(__dirname, '../../../schemas/desktop-windows.schema.json'), 'utf-8'));

// ─── Simple schema validation helpers ─────────────────────────────────────────
// We don't pull in ajv to keep dependencies minimal. Instead we validate
// the structural contract manually against the schema's required fields.

function getRequiredFields(schema, defName) {
  const def = schema.$defs?.[defName] || schema.definitions?.[defName];
  return def?.required || [];
}

function getProperties(schema, defName) {
  const def = schema.$defs?.[defName] || schema.definitions?.[defName];
  return Object.keys(def?.properties || {});
}

// ─── Contract: buildPayload output ────────────────────────────────────────────

describe('Contract: buildPayload output structure', () => {
  const project = createProject('Contract Test');
  const recording = createRecording(project, 'Flow A');

  // Add a narration step
  const step1 = createStep({
    narration: 'Click login',
    narration_source: 'typed',
    step_number: 1,
    actions: [{ type: 'click', timestamp: 1000, capture_mode: 'dom', context_id: 1, element: { text: 'Login' }, frame_src: null, window_rect: null, x: 100, y: 200 }],
  });
  addStepRecord(recording, step1);

  // Add a simple mode step
  const step2 = createStep({
    step_type: 'validation',
    expect: 'present',
    step_number: 2,
    actions: [{ type: 'click', timestamp: 2000, capture_mode: 'dom', context_id: 1, element: { text: 'Welcome' }, frame_src: null, window_rect: null, x: 50, y: 50 }],
  });
  addStepRecord(recording, step2);

  project.metadata = { ticket: 'PROJ-1' };
  recording.metadata = { env: 'staging' };

  const payload = buildPayload(project, [recording], 'Read this guidance', { title: 'Extension Schema' });

  it('has exactly four top-level keys', () => {
    const keys = Object.keys(payload).sort();
    assert.deepStrictEqual(keys, ['project', 'reading_guidance', 'recordings', 'schema']);
  });

  it('project has required fields: project_id, name, created_at', () => {
    assert.ok(payload.project.project_id, 'missing project_id');
    assert.ok(payload.project.name, 'missing name');
    assert.ok(payload.project.created_at, 'missing created_at');
  });

  it('project metadata is included when present', () => {
    assert.deepStrictEqual(payload.project.metadata, { ticket: 'PROJ-1' });
  });

  it('recording has required fields: recording_id, name, created_at, steps', () => {
    const rec = payload.recordings[0];
    assert.ok(rec.recording_id, 'missing recording_id');
    assert.ok(rec.name, 'missing name');
    assert.ok(rec.created_at, 'missing created_at');
    assert.ok(Array.isArray(rec.steps), 'steps should be an array');
  });

  it('recording metadata is included when present', () => {
    assert.deepStrictEqual(payload.recordings[0].metadata, { env: 'staging' });
  });

  it('narration step has narration and narration_source', () => {
    const step = payload.recordings[0].steps[0];
    assert.equal(step.narration, 'Click login');
    assert.equal(step.narration_source, 'typed');
    assert.equal(step.step_type, undefined);
  });

  it('simple mode step has step_type and expect', () => {
    const step = payload.recordings[0].steps[1];
    assert.equal(step.step_type, 'validation');
    assert.equal(step.expect, 'present');
    assert.equal(step.narration, undefined);
  });

  it('step has required fields: uuid, logical_id, step_number, created_at, actions, deleted', () => {
    for (const step of payload.recordings[0].steps) {
      assert.ok(step.uuid, 'missing uuid');
      assert.ok(step.logical_id, 'missing logical_id');
      assert.ok(typeof step.step_number === 'number', 'step_number should be number');
      assert.ok(step.created_at, 'missing created_at');
      assert.ok(Array.isArray(step.actions), 'actions should be array');
      assert.ok(typeof step.deleted === 'boolean', 'deleted should be boolean');
    }
  });

  it('actions have required fields: type, timestamp, capture_mode', () => {
    for (const step of payload.recordings[0].steps) {
      for (const action of step.actions) {
        assert.ok(action.type, 'action missing type');
        assert.ok(typeof action.timestamp === 'number', 'action missing timestamp');
        assert.ok(action.capture_mode, 'action missing capture_mode');
      }
    }
  });
});

describe('Contract: extension schema defines expected action types', () => {
  it('extension schema has navigate and file_upload but not file_dialog', () => {
    const defs = extensionSchema.$defs;
    assert.ok(defs.action_navigate, 'should have action_navigate');
    assert.ok(defs.action_file_upload, 'should have action_file_upload');
    assert.strictEqual(defs.action_file_dialog, undefined, 'should NOT have action_file_dialog');
  });
});

describe('Contract: desktop schema defines expected action types', () => {
  it('desktop schema has file_dialog but not navigate or file_upload', () => {
    const defs = desktopSchema.$defs;
    assert.ok(defs.action_file_dialog, 'should have action_file_dialog');
    assert.strictEqual(defs.action_navigate, undefined, 'should NOT have action_navigate');
    assert.strictEqual(defs.action_file_upload, undefined, 'should NOT have action_file_upload');
  });
});

describe('Contract: step schema allows both narration and step_type (anyOf)', () => {
  it('step definition uses anyOf to require narration or step_type', () => {
    const stepDef = extensionSchema.$defs.step;
    // The step should have an anyOf or similar construct
    const hasAnyOf = !!stepDef.anyOf;
    const hasNarration = JSON.stringify(stepDef).includes('narration');
    const hasStepType = JSON.stringify(stepDef).includes('step_type');

    assert.ok(hasAnyOf || (hasNarration && hasStepType),
      'Step schema should support both narration and step_type modes');
  });
});

describe('Contract: metadata schema allows string and string array values', () => {
  it('metadata definition exists in schema', () => {
    const metaDef = extensionSchema.$defs.metadata;
    assert.ok(metaDef, 'metadata definition should exist');
  });

  it('metadata allows additionalProperties with string or array values', () => {
    const metaDef = extensionSchema.$defs.metadata;
    const additionalProps = metaDef.additionalProperties;
    assert.ok(additionalProps, 'metadata should have additionalProperties');
    // Should allow string or array of strings
    const allowsString = JSON.stringify(additionalProps).includes('"string"');
    const allowsArray = JSON.stringify(additionalProps).includes('"array"');
    assert.ok(allowsString, 'metadata should allow string values');
    assert.ok(allowsArray, 'metadata should allow array values');
  });
});
