/**
 * import-project.test.js — the shared import builder (lib/import-project.js).
 *
 * Import is the counterpart to export: buildImportedProject reconstructs a local
 * project from a `.docent.json` export object, and the reconstruction must
 * re-export to a file that still validates against the platform schema.
 *
 * The regression pins the round-trip for a simple-mode recording (issue #293):
 * a schema-valid file imported and re-exported must stay schema-valid, with
 * `step_type`/`expect` preserved and no `narration_source` stamped onto a step
 * that legally lacks it. Validation uses the REAL composed schemas (Ajv), and the
 * re-export is round-tripped through JSON first — the on-disk form — so an
 * `undefined`-valued key is dropped exactly as a written file would drop it.
 *
 * Closes #293
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { composePlatform } from '../../../../scripts/build-schemas.js';
import { buildExport } from '../../lib/export-project.js';
import { buildImportedProject, normalizeImportedStep } from '../../lib/import-project.js';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The step-level format is defined by the shared base schema, so a step must
// re-export valid on every platform. Validate against both.
const PLATFORMS = ['desktop-windows', 'extension'];
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schemas = Object.fromEntries(PLATFORMS.map((p) => [p, composePlatform(p)]));
const validators = Object.fromEntries(PLATFORMS.map((p) => [p, ajv.compile(schemas[p])]));

function formatErrors(validate) {
  return (validate.errors || []).map((e) => `${e.instancePath} ${e.message}`).join('\n');
}

/**
 * Re-export a project the way the app does: build the export object, then round
 * trip it through JSON (the on-disk form) before validating.
 */
function reexportThroughFile(project, platform) {
  return JSON.parse(JSON.stringify(buildExport(project, schemas[platform])));
}

const SIMPLE_STEP = {
  uuid: '019e0000-0000-7000-8000-000000000003',
  logical_id: '019e0000-0000-7000-8000-000000000003',
  step_number: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  step_type: 'validation',
  expect: 'present',
  actions: [],
  deleted: false,
};

const NARRATION_STEP = {
  uuid: '019e0000-0000-7000-8000-00000000000a',
  logical_id: '019e0000-0000-7000-8000-00000000000a',
  step_number: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  narration: 'Confirm the total is shown',
  narration_source: 'typed',
  actions: [],
  deleted: false,
};

/** A minimal, schema-shaped import file carrying one step. */
function importFileWith(step) {
  return {
    docent_format: { platform: 'desktop-windows', schema_version: '0.0.0' },
    project: {
      project_id: '019e0000-0000-7000-8000-000000000001',
      name: 'Imported',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    recordings: [
      {
        recording_id: '019e0000-0000-7000-8000-000000000002',
        name: 'Rec',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [step],
      },
    ],
  };
}

// ─── Regression #293 ──────────────────────────────────────────────────────────
// https://github.com/Arsarneq/docent/issues/293

describe('import-project: simple-mode round-trip (#293)', () => {
  it('regression_293_simple_mode_import_reexports_schema_valid', () => {
    const project = buildImportedProject([], importFileWith(SIMPLE_STEP));

    for (const platform of PLATFORMS) {
      const reexported = reexportThroughFile(project, platform);
      const validate = validators[platform];
      assert.ok(
        validate(reexported),
        `re-export of a simple-mode import must validate against ${platform}:\n${formatErrors(validate)}`,
      );

      const step = reexported.recordings[0].steps[0];
      assert.equal(step.step_type, 'validation', 'step_type must survive import');
      assert.equal(step.expect, 'present', 'expect must survive import');
      assert.ok(
        !('narration_source' in step),
        'a simple-mode step must not gain a narration_source on import',
      );
    }
  });

  it('a narration-mode import re-exports schema-valid and keeps narration_source "typed"', () => {
    const project = buildImportedProject([], importFileWith(NARRATION_STEP));

    for (const platform of PLATFORMS) {
      const reexported = reexportThroughFile(project, platform);
      const validate = validators[platform];
      assert.ok(
        validate(reexported),
        `re-export of a narration-mode import must validate against ${platform}:\n${formatErrors(validate)}`,
      );
      const step = reexported.recordings[0].steps[0];
      assert.equal(step.narration, NARRATION_STEP.narration);
      assert.equal(step.narration_source, 'typed');
    }
  });

  it('a recording mixing narration and simple steps re-exports valid, each keeping its own fields', () => {
    const mixed = importFileWith(NARRATION_STEP);
    mixed.recordings[0].steps.push({ ...SIMPLE_STEP, step_number: 2 });
    const project = buildImportedProject([], mixed);

    for (const platform of PLATFORMS) {
      const reexported = reexportThroughFile(project, platform);
      const validate = validators[platform];
      assert.ok(
        validate(reexported),
        `re-export of a mixed recording must validate against ${platform}:\n${formatErrors(validate)}`,
      );
      const [narrationStep, simpleStep] = reexported.recordings[0].steps;
      assert.equal(narrationStep.narration_source, 'typed');
      assert.ok(!('step_type' in narrationStep), 'narration step gains no step_type');
      assert.equal(simpleStep.step_type, 'validation');
      assert.ok(!('narration_source' in simpleStep), 'simple step gains no narration_source');
    }
  });

  it('project and recording metadata survive the round-trip', () => {
    const file = importFileWith(SIMPLE_STEP);
    file.project.metadata = { jira: 'EXP-123', tags: ['smoke', 'critical'] };
    file.recordings[0].metadata = { ticket: 'EXP-456' };
    const project = buildImportedProject([], file);

    for (const platform of PLATFORMS) {
      const reexported = reexportThroughFile(project, platform);
      assert.ok(
        validators[platform](reexported),
        `metadata round-trip must validate against ${platform}`,
      );
      assert.deepEqual(reexported.project.metadata, {
        jira: 'EXP-123',
        tags: ['smoke', 'critical'],
      });
      assert.deepEqual(reexported.recordings[0].metadata, { ticket: 'EXP-456' });
    }
  });
});

// ─── normalizeImportedStep ────────────────────────────────────────────────────

describe('normalizeImportedStep', () => {
  it('carries step_type/expect and stamps no narration_source on a simple-mode step', () => {
    const out = normalizeImportedStep(SIMPLE_STEP);
    assert.equal(out.step_type, 'validation');
    assert.equal(out.expect, 'present');
    assert.ok(!('narration_source' in out), 'no narration_source key');
    assert.ok(!('narration' in out), 'no narration key');
  });

  it('keeps narration and narration_source on a narration-mode step', () => {
    const out = normalizeImportedStep(NARRATION_STEP);
    assert.equal(out.narration, NARRATION_STEP.narration);
    assert.equal(out.narration_source, 'typed');
    assert.ok(!('step_type' in out), 'no step_type key');
    assert.ok(!('expect' in out), 'no expect key');
  });

  it('mints a fresh uuid when the imported step lacks one, and defaults actions/deleted', () => {
    const out = normalizeImportedStep({
      logical_id: SIMPLE_STEP.logical_id,
      step_number: 1,
      created_at: SIMPLE_STEP.created_at,
      step_type: 'action',
    });
    assert.match(out.uuid, UUIDV7_RE);
    assert.deepEqual(out.actions, []);
    assert.equal(out.deleted, false);
  });
});

// ─── buildImportedProject ─────────────────────────────────────────────────────

describe('buildImportedProject', () => {
  it('preserves project_id and name when no duplicate exists', () => {
    const file = importFileWith(SIMPLE_STEP);
    const project = buildImportedProject([], file);
    assert.equal(project.project_id, file.project.project_id);
    assert.equal(project.name, file.project.name);
    assert.equal(project.recordings.length, 1);
  });

  it('imports as a "(copy)" with a fresh id when the project_id already exists', () => {
    const file = importFileWith(SIMPLE_STEP);
    const project = buildImportedProject([{ project_id: file.project.project_id }], file);
    assert.notEqual(project.project_id, file.project.project_id);
    assert.equal(project.name, `${file.project.name} (copy)`);
    assert.match(project.project_id, UUIDV7_RE);
  });
});
