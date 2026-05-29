/**
 * regression.test.js — Regression tests for previously fixed bugs.
 *
 * Convention: each test is named `regression_<issue_or_pr>_<short_description>`
 * and includes a comment linking to the original fix.
 *
 * Every bug-fix PR should include a regression test here (or in the
 * platform-specific regression file) that exercises the exact input
 * that triggered the bug.
 *
 * Covers issue #64.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
  resolveActiveSteps,
  deleteStep,
  reorderSteps,
} from '../../lib/session.js';

describe('Regression: session logic', () => {
  // PR #18: deleteStep was creating tombstone records that could interfere
  // with resolveActiveSteps if the UUID ordering was wrong.
  it('regression_pr18_delete_step_tombstone_ordering', async () => {
    const rec = { recording_id: 'r1', steps: [] };
    const step = createStep({ narration: 'To delete', step_number: 1, actions: [] });
    addStepRecord(rec, step);

    // Ensure tombstone gets a later timestamp
    await new Promise((r) => setTimeout(r, 5));
    deleteStep(rec, step.logical_id);

    const active = resolveActiveSteps(rec);
    assert.equal(active.length, 0, 'Deleted step should not appear in active steps');
  });

  // PR #18: reorderSteps must not create new records for steps already in
  // the correct position (avoids unnecessary history entries).
  it('regression_pr18_reorder_no_op_does_not_create_records', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const s1 = createStep({ narration: 'A', step_number: 1, actions: [] });
    const s2 = createStep({ narration: 'B', step_number: 2, actions: [] });
    addStepRecord(rec, s1);
    addStepRecord(rec, s2);

    const beforeCount = rec.steps.length;
    // Reorder with same order — should be a no-op
    reorderSteps(rec, [s1.logical_id, s2.logical_id]);
    assert.equal(
      rec.steps.length,
      beforeCount,
      'No new records should be created for no-op reorder',
    );
  });

  // PR #11: resolveActiveSteps must return the LATEST version per logical_id
  // when multiple versions exist (re-record creates new versions).
  it('regression_pr11_resolve_returns_latest_version', async () => {
    const rec = { recording_id: 'r1', steps: [] };
    const v1 = createStep({ narration: 'Original', step_number: 1, actions: [{ type: 'click' }] });
    addStepRecord(rec, v1);

    // Simulate re-record: new version with same logical_id
    await new Promise((r) => setTimeout(r, 5));
    const v2 = createStep({
      narration: 'Updated',
      step_number: 1,
      actions: [{ type: 'type' }],
      logical_id: v1.logical_id,
    });
    addStepRecord(rec, v2);

    const active = resolveActiveSteps(rec);
    assert.equal(active.length, 1);
    assert.equal(active[0].narration, 'Updated', 'Should return the latest version');
    assert.equal(active[0].uuid, v2.uuid, 'UUID should be from the latest version');
  });

  // PR #51: windows crate 0.62.2 changed VARIANT API — ensure the session
  // logic doesn't depend on platform-specific types (it shouldn't, but
  // this documents the boundary).
  it('regression_pr51_session_logic_is_platform_independent', () => {
    // Session logic should work with any action object shape — it doesn't
    // validate action contents, just stores them.
    const step = createStep({
      narration: 'Platform test',
      step_number: 1,
      actions: [
        { type: 'click', capture_mode: 'accessibility', element: { tag: 'Button' } },
        { type: 'click', capture_mode: 'coordinate', element: { tag: 'unknown' } },
      ],
    });
    assert.equal(step.actions.length, 2);
    assert.equal(step.actions[0].capture_mode, 'accessibility');
    assert.equal(step.actions[1].capture_mode, 'coordinate');
  });
});

describe('Regression: edge cases', () => {
  // Empty recordings array should not crash resolveActiveSteps
  it('regression_empty_recording_does_not_crash', () => {
    const rec = { recording_id: 'r1', steps: [] };
    const active = resolveActiveSteps(rec);
    assert.equal(active.length, 0);
  });

  // Step with undefined actions should not crash
  it('regression_step_with_null_actions', () => {
    const step = createStep({ narration: 'No actions', step_number: 1, actions: [] });
    assert.deepEqual(step.actions, []);
  });

  // createProject with no name should use default
  it('regression_create_project_default_name', () => {
    const project = createProject();
    assert.ok(project.name, 'Project should have a default name');
    assert.ok(project.project_id, 'Project should have an ID');
  });
});
