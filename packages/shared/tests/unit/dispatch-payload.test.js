/**
 * dispatch-payload.test.js — Unit tests for buildPayload with metadata and simple mode.
 *
 * Validates that buildPayload correctly includes/excludes metadata and
 * step_type/expect fields in the dispatch payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload } from '../../dispatch-core.js';
import { STUB_SCHEMA } from '../fixtures/stub-schema.js';

describe('buildPayload — metadata handling', () => {
  it('includes project metadata when present', () => {
    const project = {
      project_id: 'p1',
      name: 'P',
      created_at: '2026-01-01T00:00:00.000Z',
      metadata: { ticket: 'PROJ-1', tags: ['smoke'] },
    };
    const payload = buildPayload(project, [], 'guidance', STUB_SCHEMA);
    assert.deepStrictEqual(payload.project.metadata, { ticket: 'PROJ-1', tags: ['smoke'] });
  });

  it('omits project metadata when absent', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const payload = buildPayload(project, [], 'guidance', STUB_SCHEMA);
    assert.equal(payload.project.metadata, undefined);
  });

  it('includes recording metadata when present', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        metadata: { env: 'prod' },
        steps: [],
      },
    ];
    const payload = buildPayload(project, recordings, 'guidance', STUB_SCHEMA);
    assert.deepStrictEqual(payload.recordings[0].metadata, { env: 'prod' });
  });

  it('omits recording metadata when absent', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [],
      },
    ];
    const payload = buildPayload(project, recordings, 'guidance', STUB_SCHEMA);
    assert.equal(payload.recordings[0].metadata, undefined);
  });
});

describe('buildPayload — simple mode step fields', () => {
  it('includes step_type and expect for validation steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'validation',
            expect: 'present',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', STUB_SCHEMA);
    assert.equal(payload.recordings[0].steps[0].step_type, 'validation');
    assert.equal(payload.recordings[0].steps[0].expect, 'present');
  });

  it('includes step_type without expect for action steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'action',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', STUB_SCHEMA);
    assert.equal(payload.recordings[0].steps[0].step_type, 'action');
    assert.equal(payload.recordings[0].steps[0].expect, undefined);
  });

  it('includes narration fields for narration mode steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            narration: 'Click login',
            narration_source: 'typed',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', STUB_SCHEMA);
    assert.equal(payload.recordings[0].steps[0].narration, 'Click login');
    assert.equal(payload.recordings[0].steps[0].narration_source, 'typed');
    assert.equal(payload.recordings[0].steps[0].step_type, undefined);
  });

  it('omits narration fields when not present on simple mode steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'action',
            actions: [{ type: 'click' }],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', STUB_SCHEMA);
    assert.equal(payload.recordings[0].steps[0].narration, undefined);
    assert.equal(payload.recordings[0].steps[0].narration_source, undefined);
  });
});

describe('buildPayload — mixed mode recordings', () => {
  it('handles recordings with both narration and simple mode steps', () => {
    const project = { project_id: 'p1', name: 'P', created_at: '2026-01-01T00:00:00.000Z' };
    const recordings = [
      {
        recording_id: 'r1',
        name: 'R',
        created_at: '2026-01-01T00:00:00.000Z',
        steps: [
          {
            uuid: 'u1',
            logical_id: 'l1',
            step_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            narration: 'Login',
            narration_source: 'typed',
            actions: [],
            deleted: false,
          },
          {
            uuid: 'u2',
            logical_id: 'l2',
            step_number: 2,
            created_at: '2026-01-01T00:00:00.000Z',
            step_type: 'validation',
            expect: 'absent',
            actions: [],
            deleted: false,
          },
        ],
      },
    ];
    const payload = buildPayload(project, recordings, '', STUB_SCHEMA);
    const steps = payload.recordings[0].steps;

    assert.equal(steps[0].narration, 'Login');
    assert.equal(steps[0].step_type, undefined);
    assert.equal(steps[1].step_type, 'validation');
    assert.equal(steps[1].expect, 'absent');
    assert.equal(steps[1].narration, undefined);
  });
});
