/**
 * render-views.test.js — Unit tests for shared rendering view functions.
 *
 * Tests renderProjectList, renderRecordingList, renderStepList, and
 * renderStepDetail from packages/shared/views/render.js.
 * These functions have coverage gaps in the existing render.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderProjectList,
  renderRecordingList,
  renderStepList,
  renderStepDetail,
} from '../views/render.js';

// ─── renderProjectList ────────────────────────────────────────────────────────

describe('renderProjectList', () => {
  it('returns empty array for empty input', () => {
    const result = renderProjectList([]);
    assert.deepEqual(result, []);
  });

  it('renders a single project with correct structure', () => {
    const projects = [{ project_id: 'p1', name: 'My Project', recording_count: 3 }];
    const result = renderProjectList(projects);

    assert.equal(result.length, 1);
    assert.ok(result[0].includes('data-project-id="p1"'));
    assert.ok(result[0].includes('My Project'));
    assert.ok(result[0].includes('3 recordings'));
    assert.ok(result[0].includes('data-action="open"'));
    assert.ok(result[0].includes('data-action="delete"'));
  });

  it('uses singular "recording" for count of 1', () => {
    const projects = [{ project_id: 'p1', name: 'Solo', recording_count: 1 }];
    const result = renderProjectList(projects);

    assert.ok(result[0].includes('1 recording'));
    assert.ok(!result[0].includes('1 recordings'));
  });

  it('uses plural "recordings" for count of 0', () => {
    const projects = [{ project_id: 'p1', name: 'Empty', recording_count: 0 }];
    const result = renderProjectList(projects);

    assert.ok(result[0].includes('0 recordings'));
  });

  it('escapes HTML in project name', () => {
    const projects = [
      { project_id: 'p1', name: '<script>alert("xss")</script>', recording_count: 0 },
    ];
    const result = renderProjectList(projects);

    assert.ok(result[0].includes('&lt;script&gt;'));
    assert.ok(!result[0].includes('<script>'));
  });

  it('renders multiple projects', () => {
    const projects = [
      { project_id: 'p1', name: 'First', recording_count: 2 },
      { project_id: 'p2', name: 'Second', recording_count: 5 },
    ];
    const result = renderProjectList(projects);

    assert.equal(result.length, 2);
    assert.ok(result[0].includes('First'));
    assert.ok(result[1].includes('Second'));
  });
});

// ─── renderRecordingList ──────────────────────────────────────────────────────

describe('renderRecordingList', () => {
  it('returns empty array for empty input', () => {
    const result = renderRecordingList([]);
    assert.deepEqual(result, []);
  });

  it('renders recording with step count from active steps', () => {
    const recordings = [
      {
        recording_id: 'r1',
        name: 'Login Flow',
        steps: [
          { logical_id: 'l1', uuid: '001', step_number: 1, deleted: false },
          { logical_id: 'l2', uuid: '002', step_number: 2, deleted: false },
        ],
      },
    ];
    const result = renderRecordingList(recordings);

    assert.equal(result.length, 1);
    assert.ok(result[0].includes('data-recording-id="r1"'));
    assert.ok(result[0].includes('Login Flow'));
    assert.ok(result[0].includes('2 steps'));
  });

  it('uses singular "step" for count of 1', () => {
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        steps: [{ logical_id: 'l1', uuid: '001', step_number: 1, deleted: false }],
      },
    ];
    const result = renderRecordingList(recordings);

    assert.ok(result[0].includes('1 step'));
    assert.ok(!result[0].includes('1 steps'));
  });

  it('excludes deleted steps from count', () => {
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        steps: [
          { logical_id: 'l1', uuid: '001', step_number: 1, deleted: false },
          { logical_id: 'l2', uuid: '002', step_number: 2, deleted: true },
        ],
      },
    ];
    const result = renderRecordingList(recordings);

    assert.ok(result[0].includes('1 step'));
  });

  it('resolves active steps — latest uuid wins per logical_id', () => {
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        steps: [
          { logical_id: 'l1', uuid: '001', step_number: 1, deleted: false },
          { logical_id: 'l1', uuid: '002', step_number: 1, deleted: false }, // newer version
          { logical_id: 'l2', uuid: '003', step_number: 2, deleted: false },
        ],
      },
    ];
    const result = renderRecordingList(recordings);

    // 2 unique logical_ids, both active
    assert.ok(result[0].includes('2 steps'));
  });

  it('handles recording with no steps', () => {
    const recordings = [{ recording_id: 'r1', name: 'Empty', steps: [] }];
    const result = renderRecordingList(recordings);

    assert.ok(result[0].includes('0 steps'));
  });

  it('handles recording with undefined steps', () => {
    const recordings = [{ recording_id: 'r1', name: 'No Steps' }];
    const result = renderRecordingList(recordings);

    assert.ok(result[0].includes('0 steps'));
  });
});

// ─── renderStepList ───────────────────────────────────────────────────────────

describe('renderStepList', () => {
  it('returns empty array for empty input', () => {
    const result = renderStepList([]);
    assert.deepEqual(result, []);
  });

  it('renders step with narration as label', () => {
    const steps = [{ logical_id: 'l1', narration: 'Click the login button', actions: [] }];
    const result = renderStepList(steps);

    assert.equal(result.length, 1);
    assert.ok(result[0].includes('Click the login button'));
    assert.ok(result[0].includes('data-logical="l1"'));
    assert.ok(result[0].includes('draggable="true"'));
  });

  it('renders step with step_type as label when no narration', () => {
    const steps = [{ logical_id: 'l1', step_type: 'action', actions: [] }];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('action'));
  });

  it('renders step_type with expect in parentheses', () => {
    const steps = [{ logical_id: 'l1', step_type: 'validation', expect: 'present', actions: [] }];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('validation (present)'));
  });

  it('falls back to "Step N" when no narration or step_type', () => {
    const steps = [
      { logical_id: 'l1', actions: [] },
      { logical_id: 'l2', actions: [] },
    ];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('Step 1'));
    assert.ok(result[1].includes('Step 2'));
  });

  it('escapes HTML in narration', () => {
    const steps = [{ logical_id: 'l1', narration: '<img onerror="alert(1)">', actions: [] }];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('&lt;img'));
    assert.ok(!result[0].includes('<img'));
  });

  it('includes edit, history, and delete action buttons', () => {
    const steps = [{ logical_id: 'l1', narration: 'Test', actions: [] }];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('data-action="edit"'));
    assert.ok(result[0].includes('data-action="history"'));
    assert.ok(result[0].includes('data-action="delete"'));
  });

  it('shows correct step numbers (1-indexed)', () => {
    const steps = [
      { logical_id: 'l1', narration: 'First', actions: [] },
      { logical_id: 'l2', narration: 'Second', actions: [] },
      { logical_id: 'l3', narration: 'Third', actions: [] },
    ];
    const result = renderStepList(steps);

    assert.ok(result[0].includes('<span class="step-number">1</span>'));
    assert.ok(result[1].includes('<span class="step-number">2</span>'));
    assert.ok(result[2].includes('<span class="step-number">3</span>'));
  });
});

// ─── renderStepDetail ─────────────────────────────────────────────────────────

describe('renderStepDetail', () => {
  it('returns empty state for null actions', () => {
    const result = renderStepDetail(null);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('No actions recorded'));
  });

  it('returns empty state for empty actions array', () => {
    const result = renderStepDetail([]);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('No actions recorded'));
  });

  it('returns empty state for undefined actions', () => {
    const result = renderStepDetail(undefined);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('No actions recorded'));
  });

  it('renders single action with index, type, and description', () => {
    const actions = [{ type: 'click', element: { text: 'Submit', selector: '#btn' } }];
    const result = renderStepDetail(actions);

    assert.equal(result.length, 1);
    assert.ok(result[0].includes('step-detail-index'));
    assert.ok(result[0].includes('1'));
    assert.ok(result[0].includes('click'));
    assert.ok(result[0].includes('Submit'));
  });

  it('renders multiple actions with correct indices', () => {
    const actions = [
      { type: 'click', element: { text: 'Login' } },
      { type: 'type', element: { selector: '#email' }, value: 'test@test.com' },
      { type: 'key', key: 'Enter', element: { selector: '#form' } },
    ];
    const result = renderStepDetail(actions);

    assert.equal(result.length, 3);
    assert.ok(result[0].includes('>1<'));
    assert.ok(result[1].includes('>2<'));
    assert.ok(result[2].includes('>3<'));
  });

  it('escapes HTML in action type', () => {
    const actions = [{ type: '<b>bold</b>', element: {} }];
    const result = renderStepDetail(actions);

    assert.ok(result[0].includes('&lt;b&gt;bold&lt;/b&gt;'));
  });
});
