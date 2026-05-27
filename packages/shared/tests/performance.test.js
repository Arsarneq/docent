/**
 * performance.test.js — Performance tests for data layer operations.
 *
 * Validates that core operations complete within acceptable time bounds
 * even with large datasets. These are not micro-benchmarks — they verify
 * that nothing is accidentally O(n²) or worse.
 *
 * Thresholds are generous (10x expected) to avoid flaky CI failures
 * while still catching catastrophic regressions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createRecording, createStep, addStepRecord, resolveActiveSteps, reorderSteps, deleteStep } from '../lib/session.js';
import { buildPayload } from '../dispatch-core.js';
import { renderStepList, renderStepDetail, renderProjectList, renderRecordingList } from '../views/render.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateLargeProject(recordingCount, stepsPerRecording, actionsPerStep = 3) {
  const project = createProject('Large Project');
  project.metadata = { ticket: 'PERF-1', tags: ['smoke', 'regression', 'critical'] };

  for (let r = 0; r < recordingCount; r++) {
    const recording = createRecording(project, `Recording ${r + 1}`);
    recording.metadata = { env: 'staging', iteration: String(r) };

    for (let s = 0; s < stepsPerRecording; s++) {
      const actions = [];
      for (let a = 0; a < actionsPerStep; a++) {
        actions.push({
          type: 'click',
          timestamp: Date.now() + s * 1000 + a,
          capture_mode: 'dom',
          context_id: 1,
          element: { text: `Element ${a}`, selector: `#el-${a}`, tag: 'BUTTON' },
          frame_src: null,
          window_rect: null,
          x: 100 + a * 10,
          y: 200 + a * 10,
        });
      }

      const step = createStep({
        narration: `Step ${s + 1}: perform action ${s}`,
        narration_source: 'typed',
        step_number: s + 1,
        actions,
      });
      addStepRecord(recording, step);
    }
  }

  return project;
}

function timeMs(fn) {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  return { result, elapsed };
}

// ─── Performance: resolveActiveSteps ──────────────────────────────────────────

describe('Performance: resolveActiveSteps', () => {
  it('resolves 500 steps in under 50ms', () => {
    const project = generateLargeProject(1, 500);
    const recording = project.recordings[0];

    const { elapsed } = timeMs(() => resolveActiveSteps(recording));

    assert.ok(elapsed < 50, `resolveActiveSteps took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
  });

  it('resolves 500 steps with 50% deleted versions in under 100ms', () => {
    const project = generateLargeProject(1, 500);
    const recording = project.recordings[0];

    // Delete every other step (creates tombstone records)
    const active = resolveActiveSteps(recording);
    for (let i = 0; i < active.length; i += 2) {
      deleteStep(recording, active[i].logical_id);
    }

    const { elapsed } = timeMs(() => resolveActiveSteps(recording));

    assert.ok(elapsed < 100, `resolveActiveSteps with deletions took ${elapsed.toFixed(1)}ms (limit: 100ms)`);
  });
});

// ─── Performance: buildPayload ────────────────────────────────────────────────

describe('Performance: buildPayload', () => {
  it('builds payload for 10 recordings × 50 steps in under 50ms', () => {
    const project = generateLargeProject(10, 50);

    const { elapsed } = timeMs(() =>
      buildPayload(project, project.recordings, 'guidance text', { title: 'schema' })
    );

    assert.ok(elapsed < 50, `buildPayload took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
  });

  it('builds payload for 100 recordings × 10 steps in under 100ms', () => {
    const project = generateLargeProject(100, 10);

    const { elapsed } = timeMs(() =>
      buildPayload(project, project.recordings, 'guidance text', { title: 'schema' })
    );

    assert.ok(elapsed < 100, `buildPayload took ${elapsed.toFixed(1)}ms (limit: 100ms)`);
  });

  it('serialized payload size is reasonable (< 5MB for 10×50)', () => {
    const project = generateLargeProject(10, 50);
    const payload = buildPayload(project, project.recordings, 'guidance', {});
    const json = JSON.stringify(payload);

    const sizeMB = json.length / (1024 * 1024);
    assert.ok(sizeMB < 5, `Payload size ${sizeMB.toFixed(2)}MB exceeds 5MB limit`);
  });
});

// ─── Performance: renderStepList ──────────────────────────────────────────────

describe('Performance: renderStepList', () => {
  it('renders 200 steps in under 50ms', () => {
    const project = generateLargeProject(1, 200);
    const steps = resolveActiveSteps(project.recordings[0]);

    const { elapsed } = timeMs(() => renderStepList(steps));

    assert.ok(elapsed < 50, `renderStepList took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
  });
});

describe('Performance: renderProjectList', () => {
  it('renders 100 projects in under 20ms', () => {
    const projects = [];
    for (let i = 0; i < 100; i++) {
      projects.push({ project_id: `p${i}`, name: `Project ${i}`, recording_count: 5 });
    }

    const { elapsed } = timeMs(() => renderProjectList(projects));

    assert.ok(elapsed < 20, `renderProjectList took ${elapsed.toFixed(1)}ms (limit: 20ms)`);
  });
});

describe('Performance: renderRecordingList', () => {
  it('renders 50 recordings with steps in under 30ms', () => {
    const recordings = [];
    for (let i = 0; i < 50; i++) {
      recordings.push({
        recording_id: `r${i}`,
        name: `Recording ${i}`,
        steps: Array.from({ length: 20 }, (_, j) => ({
          logical_id: `l${i}-${j}`,
          uuid: `u${i}-${j}-${Date.now()}`,
          deleted: j % 10 === 0,
        })),
      });
    }

    const { elapsed } = timeMs(() => renderRecordingList(recordings));

    assert.ok(elapsed < 30, `renderRecordingList took ${elapsed.toFixed(1)}ms (limit: 30ms)`);
  });
});

// ─── Performance: JSON serialization ──────────────────────────────────────────

describe('Performance: JSON serialization round-trip', () => {
  it('serialize + deserialize 100 recordings × 50 steps in under 200ms', () => {
    const project = generateLargeProject(100, 50, 2);

    const { elapsed: serializeTime, result: json } = timeMs(() => JSON.stringify(project));
    const { elapsed: deserializeTime } = timeMs(() => JSON.parse(json));

    const total = serializeTime + deserializeTime;
    assert.ok(total < 200, `Round-trip took ${total.toFixed(1)}ms (limit: 200ms)`);
  });
});

// ─── Performance: reorderSteps ────────────────────────────────────────────────

describe('Performance: reorderSteps', () => {
  it('reorders 100 steps in under 50ms', () => {
    const project = generateLargeProject(1, 100);
    const recording = project.recordings[0];
    const active = resolveActiveSteps(recording);

    // Reverse the order
    const reversed = [...active].reverse().map(s => s.logical_id);

    const { elapsed } = timeMs(() => reorderSteps(recording, reversed));

    assert.ok(elapsed < 50, `reorderSteps took ${elapsed.toFixed(1)}ms (limit: 50ms)`);
  });
});
