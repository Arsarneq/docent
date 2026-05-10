/**
 * simple-mode.test.js — Unit tests for simple mode step creation and rendering.
 *
 * Tests createStep() with step_type/expect fields and renderStepList()
 * with steps that lack narration (simple mode steps).
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStep, resolveActiveSteps, addStepRecord } from '../lib/session.js';
import { renderStepList } from '../views/render.js';

// ─── createStep with simple mode fields ───────────────────────────────────────

describe('createStep — simple mode', () => {
  it('creates a step with step_type only (action)', () => {
    const step = createStep({
      step_type: 'action',
      step_number: 1,
      actions: [{ type: 'click', element: { text: 'Submit' } }],
    });

    assert.equal(step.step_type, 'action');
    assert.equal(step.expect, undefined);
    assert.equal(step.narration, undefined);
    assert.equal(step.narration_source, undefined);
    assert.equal(step.step_number, 1);
    assert.equal(step.deleted, false);
    assert.ok(step.uuid);
    assert.ok(step.logical_id);
    assert.ok(step.created_at);
  });

  it('creates a step with step_type=validation and expect=present', () => {
    const step = createStep({
      step_type: 'validation',
      expect: 'present',
      step_number: 2,
      actions: [{ type: 'click', element: { text: 'Check' } }],
    });

    assert.equal(step.step_type, 'validation');
    assert.equal(step.expect, 'present');
    assert.equal(step.narration, undefined);
  });

  it('creates a step with step_type=validation and expect=absent', () => {
    const step = createStep({
      step_type: 'validation',
      expect: 'absent',
      step_number: 3,
      actions: [],
    });

    assert.equal(step.step_type, 'validation');
    assert.equal(step.expect, 'absent');
  });

  it('creates a step with narration (narration mode — backward compat)', () => {
    const step = createStep({
      narration: 'Log into the system',
      narration_source: 'typed',
      step_number: 1,
      actions: [{ type: 'click', element: { text: 'Login' } }],
    });

    assert.equal(step.narration, 'Log into the system');
    assert.equal(step.narration_source, 'typed');
    assert.equal(step.step_type, undefined);
    assert.equal(step.expect, undefined);
  });

  it('creates a step with both narration and step_type (schema allows anyOf)', () => {
    const step = createStep({
      narration: 'Verify the button is visible',
      narration_source: 'typed',
      step_type: 'validation',
      expect: 'present',
      step_number: 1,
      actions: [],
    });

    assert.equal(step.narration, 'Verify the button is visible');
    assert.equal(step.step_type, 'validation');
    assert.equal(step.expect, 'present');
  });

  it('preserves logical_id when provided (re-record)', () => {
    const step = createStep({
      step_type: 'action',
      step_number: 1,
      actions: [],
      logical_id: 'existing-logical-id',
    });

    assert.equal(step.logical_id, 'existing-logical-id');
  });
});

// ─── resolveActiveSteps with simple mode steps ────────────────────────────────

describe('resolveActiveSteps — simple mode steps', () => {
  it('resolves simple mode steps correctly', () => {
    const recording = { recording_id: 'r1', name: 'Test', steps: [] };

    const step1 = createStep({ step_type: 'action', step_number: 1, actions: [] });
    const step2 = createStep({ step_type: 'validation', expect: 'present', step_number: 2, actions: [] });

    addStepRecord(recording, step1);
    addStepRecord(recording, step2);

    const active = resolveActiveSteps(recording);
    assert.equal(active.length, 2);
    assert.equal(active[0].step_type, 'action');
    assert.equal(active[1].step_type, 'validation');
    assert.equal(active[1].expect, 'present');
  });

  it('resolves mixed narration and simple mode steps', () => {
    const recording = { recording_id: 'r1', name: 'Test', steps: [] };

    const step1 = createStep({ narration: 'Click login', narration_source: 'typed', step_number: 1, actions: [] });
    const step2 = createStep({ step_type: 'validation', expect: 'absent', step_number: 2, actions: [] });

    addStepRecord(recording, step1);
    addStepRecord(recording, step2);

    const active = resolveActiveSteps(recording);
    assert.equal(active.length, 2);
    assert.equal(active[0].narration, 'Click login');
    assert.equal(active[1].step_type, 'validation');
    assert.equal(active[1].expect, 'absent');
  });
});

// ─── renderStepList with simple mode steps ────────────────────────────────────

describe('renderStepList — simple mode steps', () => {
  it('renders step_type as label when narration is absent', () => {
    const steps = [
      { logical_id: 'l1', step_type: 'action', step_number: 1, actions: [] },
    ];
    const html = renderStepList(steps);
    assert.equal(html.length, 1);
    assert.ok(html[0].includes('action'), 'Should contain step_type "action"');
    assert.ok(!html[0].includes('undefined'), 'Should not contain "undefined"');
  });

  it('renders step_type + expect for validation steps', () => {
    const steps = [
      { logical_id: 'l1', step_type: 'validation', expect: 'present', step_number: 1, actions: [] },
    ];
    const html = renderStepList(steps);
    assert.ok(html[0].includes('validation'), 'Should contain "validation"');
    assert.ok(html[0].includes('present'), 'Should contain "present"');
  });

  it('renders narration when present (narration mode)', () => {
    const steps = [
      { logical_id: 'l1', narration: 'Log into system', step_number: 1, actions: [] },
    ];
    const html = renderStepList(steps);
    assert.ok(html[0].includes('Log into system'), 'Should contain narration text');
  });

  it('prefers narration over step_type when both present', () => {
    const steps = [
      { logical_id: 'l1', narration: 'Check button', step_type: 'validation', expect: 'present', step_number: 1, actions: [] },
    ];
    const html = renderStepList(steps);
    assert.ok(html[0].includes('Check button'), 'Should show narration');
    // step_type may or may not appear, but narration takes priority
  });

  it('renders fallback label when neither narration nor step_type present', () => {
    const steps = [
      { logical_id: 'l1', step_number: 1, actions: [] },
    ];
    const html = renderStepList(steps);
    assert.ok(html[0].includes('Step 1'), 'Should contain fallback "Step 1"');
    assert.ok(!html[0].includes('undefined'), 'Should not contain "undefined"');
  });

  it('does not render "undefined" for any simple mode step', () => {
    const steps = [
      { logical_id: 'l1', step_type: 'action', step_number: 1, actions: [] },
      { logical_id: 'l2', step_type: 'validation', expect: 'absent', step_number: 2, actions: [] },
    ];
    const html = renderStepList(steps);
    for (const h of html) {
      assert.ok(!h.includes('undefined'), `Should not contain "undefined": ${h.substring(0, 100)}`);
    }
  });
});
