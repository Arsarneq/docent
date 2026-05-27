/**
 * session.test.js — Unit tests for the session model (session.js)
 *
 * Tests the core data model: project/recording/step creation,
 * step versioning, active step resolution, deletion, and reordering.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createProject,
  createRecording,
  findRecording,
  createStep,
  resolveActiveSteps,
  getStepHistory,
  addStepRecord,
  deleteStep,
  reorderSteps,
} from '../lib/session.js';

// ─── createProject ────────────────────────────────────────────────────────────

describe('createProject', () => {
  it('creates project with default name', () => {
    const p = createProject();
    assert.equal(p.name, 'Untitled Project');
    assert.ok(p.project_id);
    assert.ok(p.created_at);
    assert.deepEqual(p.recordings, []);
  });

  it('creates project with custom name', () => {
    const p = createProject('Login Tests');
    assert.equal(p.name, 'Login Tests');
  });

  it('generates unique project_ids', () => {
    const a = createProject();
    const b = createProject();
    assert.notEqual(a.project_id, b.project_id);
  });
});

// ─── createRecording ──────────────────────────────────────────────────────────

describe('createRecording', () => {
  it('creates recording and appends to project', () => {
    const p = createProject();
    const r = createRecording(p, 'Flow A');
    assert.equal(r.name, 'Flow A');
    assert.equal(p.recordings.length, 1);
    assert.equal(p.recordings[0], r);
  });

  it('uses default name when none provided', () => {
    const p = createProject();
    const r = createRecording(p);
    assert.equal(r.name, 'Untitled Recording');
  });

  it('generates unique recording_ids', () => {
    const p = createProject();
    const a = createRecording(p, 'A');
    const b = createRecording(p, 'B');
    assert.notEqual(a.recording_id, b.recording_id);
  });
});

// ─── findRecording ────────────────────────────────────────────────────────────

describe('findRecording', () => {
  it('finds recording by id', () => {
    const p = createProject();
    const r = createRecording(p, 'Target');
    const found = findRecording(p, r.recording_id);
    assert.equal(found, r);
  });

  it('returns undefined for non-existent id', () => {
    const p = createProject();
    createRecording(p, 'Other');
    assert.equal(findRecording(p, 'non-existent'), undefined);
  });
});

// ─── createStep ───────────────────────────────────────────────────────────────

describe('createStep', () => {
  it('creates step with narration (narration mode)', () => {
    const s = createStep({
      narration: 'Click the login button',
      narration_source: 'typed',
      step_number: 1,
      actions: [{ type: 'click', element: { text: 'Login' } }],
    });
    assert.equal(s.narration, 'Click the login button');
    assert.equal(s.narration_source, 'typed');
    assert.equal(s.step_number, 1);
    assert.equal(s.deleted, false);
    assert.ok(s.uuid);
    assert.ok(s.logical_id);
  });

  it('creates step with step_type (simple mode)', () => {
    const s = createStep({
      step_type: 'validation',
      expect: 'present',
      step_number: 2,
      actions: [{ type: 'click', element: { text: 'Submit' } }],
    });
    assert.equal(s.step_type, 'validation');
    assert.equal(s.expect, 'present');
    assert.equal(s.narration, undefined);
  });

  it('uses provided logical_id for re-recording', () => {
    const s = createStep({
      narration: 'Updated',
      narration_source: 'typed',
      step_number: 1,
      actions: [],
      logical_id: 'existing-logical-id',
    });
    assert.equal(s.logical_id, 'existing-logical-id');
  });

  it('generates new logical_id when not provided', () => {
    const a = createStep({ step_number: 1, actions: [] });
    const b = createStep({ step_number: 2, actions: [] });
    assert.notEqual(a.logical_id, b.logical_id);
  });
});

// ─── resolveActiveSteps ───────────────────────────────────────────────────────

describe('resolveActiveSteps', () => {
  it('returns empty array for recording with no steps', () => {
    const r = { recording_id: 'r1', steps: [] };
    assert.deepEqual(resolveActiveSteps(r), []);
  });

  it('returns single step when only one exists', () => {
    const step = createStep({ narration: 'One', step_number: 1, actions: [] });
    const r = { recording_id: 'r1', steps: [step] };
    const active = resolveActiveSteps(r);
    assert.equal(active.length, 1);
    assert.equal(active[0].narration, 'One');
  });

  it('returns latest version per logical_id', () => {
    const v1 = createStep({
      narration: 'Old',
      step_number: 1,
      actions: [],
      logical_id: 'lid1',
    });
    // Simulate a newer version (higher uuid)
    const v2 = {
      ...v1,
      uuid: 'z' + v1.uuid.slice(1), // lexicographically greater
      narration: 'New',
    };
    const r = { recording_id: 'r1', steps: [v1, v2] };
    const active = resolveActiveSteps(r);
    assert.equal(active.length, 1);
    assert.equal(active[0].narration, 'New');
  });

  it('excludes deleted steps', () => {
    const step = createStep({ narration: 'Deleted', step_number: 1, actions: [] });
    step.deleted = true;
    const r = { recording_id: 'r1', steps: [step] };
    assert.deepEqual(resolveActiveSteps(r), []);
  });

  it('sorts by step_number ascending', () => {
    const s3 = createStep({ narration: 'Third', step_number: 3, actions: [] });
    const s1 = createStep({ narration: 'First', step_number: 1, actions: [] });
    const s2 = createStep({ narration: 'Second', step_number: 2, actions: [] });
    const r = { recording_id: 'r1', steps: [s3, s1, s2] };
    const active = resolveActiveSteps(r);
    assert.equal(active[0].step_number, 1);
    assert.equal(active[1].step_number, 2);
    assert.equal(active[2].step_number, 3);
  });
});

// ─── getStepHistory ───────────────────────────────────────────────────────────

describe('getStepHistory', () => {
  it('returns all versions for a logical_id, newest first', () => {
    const v1 = createStep({ narration: 'V1', step_number: 1, actions: [], logical_id: 'lid1' });
    const v2 = {
      ...v1,
      uuid: 'z' + v1.uuid.slice(1),
      narration: 'V2',
    };
    const other = createStep({ narration: 'Other', step_number: 2, actions: [] });
    const r = { recording_id: 'r1', steps: [v1, v2, other] };
    const history = getStepHistory(r, 'lid1');
    assert.equal(history.length, 2);
    assert.equal(history[0].narration, 'V2'); // newest first
    assert.equal(history[1].narration, 'V1');
  });

  it('returns empty array for non-existent logical_id', () => {
    const r = { recording_id: 'r1', steps: [] };
    assert.deepEqual(getStepHistory(r, 'non-existent'), []);
  });
});

// ─── deleteStep ───────────────────────────────────────────────────────────────

describe('deleteStep', () => {
  it('creates a tombstone record for the active step', () => {
    const p = createProject();
    const rec = createRecording(p, 'R');
    const step = createStep({ narration: 'To delete', step_number: 1, actions: [] });
    addStepRecord(rec, step);

    deleteStep(rec, step.logical_id);

    assert.equal(rec.steps.length, 2);
    const tombstone = rec.steps[1];
    assert.equal(tombstone.logical_id, step.logical_id);
    assert.equal(tombstone.deleted, true);
    assert.notEqual(tombstone.uuid, step.uuid); // new uuid
  });

  it('does nothing for non-existent logical_id', () => {
    const rec = { recording_id: 'r1', steps: [] };
    deleteStep(rec, 'non-existent');
    assert.equal(rec.steps.length, 0);
  });

  it('deleted step no longer appears in resolveActiveSteps', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const step = createStep({ narration: 'Gone', step_number: 1, actions: [] });
    addStepRecord(rec, step);
    deleteStep(rec, step.logical_id);
    assert.deepEqual(resolveActiveSteps(rec), []);
  });
});

// ─── reorderSteps ─────────────────────────────────────────────────────────────

describe('reorderSteps', () => {
  it('reassigns step_numbers based on new order', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const s1 = createStep({ narration: 'A', step_number: 1, actions: [] });
    const s2 = createStep({ narration: 'B', step_number: 2, actions: [] });
    const s3 = createStep({ narration: 'C', step_number: 3, actions: [] });
    addStepRecord(rec, s1);
    addStepRecord(rec, s2);
    addStepRecord(rec, s3);

    // Reverse order: C, B, A
    reorderSteps(rec, [s3.logical_id, s2.logical_id, s1.logical_id]);

    const active = resolveActiveSteps(rec);
    assert.equal(active[0].logical_id, s3.logical_id);
    assert.equal(active[0].step_number, 1);
    assert.equal(active[1].logical_id, s2.logical_id);
    assert.equal(active[1].step_number, 2);
    assert.equal(active[2].logical_id, s1.logical_id);
    assert.equal(active[2].step_number, 3);
  });

  it('does not create new records for steps already in correct position', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const s1 = createStep({ narration: 'A', step_number: 1, actions: [] });
    const s2 = createStep({ narration: 'B', step_number: 2, actions: [] });
    addStepRecord(rec, s1);
    addStepRecord(rec, s2);

    const countBefore = rec.steps.length;
    reorderSteps(rec, [s1.logical_id, s2.logical_id]); // same order
    assert.equal(rec.steps.length, countBefore); // no new records
  });

  it('handles single step (no-op)', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const s1 = createStep({ narration: 'Only', step_number: 1, actions: [] });
    addStepRecord(rec, s1);

    reorderSteps(rec, [s1.logical_id]);
    assert.equal(rec.steps.length, 1); // no new records
  });
});
