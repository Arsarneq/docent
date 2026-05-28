/**
 * service-worker.test.js — Unit tests for service worker message handlers.
 *
 * Since the service worker uses chrome.* APIs at the top level, we cannot
 * import it directly. Instead, we replicate the core message handler logic
 * and test it with mocked state — same approach as panel.test.js.
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  createRecording,
  createStep,
  addStepRecord,
  resolveActiveSteps,
  deleteStep,
  reorderSteps,
  findRecording,
} from '../../shared/lib/session.js';

// ─── Simulated service worker state ──────────────────────────────────────────

let projects;
let activeProjectId;
let activeRecordingId;
let pendingActions;

function reset() {
  projects = [];
  activeProjectId = null;
  activeRecordingId = null;
  pendingActions = [];
}

function getActiveProject() {
  return projects.find((p) => p.project_id === activeProjectId) ?? null;
}

function getActiveRecording() {
  const project = getActiveProject();
  if (!project) return null;
  return findRecording(project, activeRecordingId) ?? null;
}

// ─── Message handler (replicated from service-worker.js) ─────────────────────

async function handle(msg) {
  switch (msg.type) {
    case 'PROJECT_CREATE': {
      const project = createProject(msg.name);
      projects.push(project);
      activeProjectId = project.project_id;
      return { ok: true, project };
    }

    case 'PROJECT_SET_METADATA': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      if (msg.metadata) {
        project.metadata = msg.metadata;
      } else {
        delete project.metadata;
      }
      return { ok: true };
    }

    case 'RECORDING_CREATE': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = createRecording(project, msg.name);
      activeRecordingId = recording.recording_id;
      pendingActions = [];
      return { ok: true, recording, project };
    }

    case 'RECORDING_RENAME': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      recording.name = msg.name;
      return { ok: true };
    }

    case 'RECORDING_SET_METADATA': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      if (msg.metadata) {
        recording.metadata = msg.metadata;
      } else {
        delete recording.metadata;
      }
      return { ok: true };
    }

    case 'RECORDING_CLEAR': {
      pendingActions = [];
      return { ok: true };
    }

    case 'STEP_COMMIT': {
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };

      const activeSteps = resolveActiveSteps(recording);
      const isRerecord = !!msg.logical_id;

      if (!isRerecord && pendingActions.length === 0) {
        return { ok: false, error: 'No actions recorded for this step' };
      }

      let actions;
      if (pendingActions.length > 0) {
        actions = pendingActions;
      } else {
        const existing = activeSteps.find((s) => s.logical_id === msg.logical_id);
        actions = existing ? [...existing.actions] : [];
      }

      const stepNumber = msg.step_number ?? activeSteps.length + 1;

      const step = createStep({
        narration: msg.narration,
        narration_source: msg.narration_source,
        step_type: msg.step_type,
        expect: msg.expect,
        step_number: stepNumber,
        actions,
        logical_id: msg.logical_id,
      });

      addStepRecord(recording, step);
      pendingActions = [];

      return { ok: true, step, activeSteps: resolveActiveSteps(recording) };
    }

    case 'STEPS_REORDER': {
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };
      reorderSteps(recording, msg.orderedLogicalIds);
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SERVICE WORKER: PROJECT_SET_METADATA', () => {
  beforeEach(reset);

  it('persists metadata on the active project', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Test' });
    const result = await handle({
      type: 'PROJECT_SET_METADATA',
      metadata: { ticket: 'PROJ-1', tags: ['smoke'] },
    });
    assert.equal(result.ok, true);
    assert.deepStrictEqual(getActiveProject().metadata, { ticket: 'PROJ-1', tags: ['smoke'] });
  });

  it('removes metadata when null is passed', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Test' });
    await handle({ type: 'PROJECT_SET_METADATA', metadata: { ticket: 'X' } });
    await handle({ type: 'PROJECT_SET_METADATA', metadata: null });
    assert.equal(getActiveProject().metadata, undefined);
  });

  it('returns error when no active project', async () => {
    const result = await handle({ type: 'PROJECT_SET_METADATA', metadata: { a: 'b' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /No active project/);
  });
});

describe('SERVICE WORKER: RECORDING_SET_METADATA', () => {
  beforeEach(reset);

  it('persists metadata on the specified recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({ type: 'RECORDING_CREATE', name: 'R' });
    const result = await handle({
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { env: 'staging' },
    });
    assert.equal(result.ok, true);
    assert.deepStrictEqual(getActiveRecording().metadata, { env: 'staging' });
  });

  it('removes metadata when null is passed', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({ type: 'RECORDING_CREATE', name: 'R' });
    await handle({
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { x: '1' },
    });
    await handle({
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: null,
    });
    assert.equal(getActiveRecording().metadata, undefined);
  });

  it('returns error for unknown recording_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const result = await handle({
      type: 'RECORDING_SET_METADATA',
      recording_id: 'nonexistent',
      metadata: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Recording not found/);
  });
});

describe('SERVICE WORKER: RECORDING_CLEAR', () => {
  beforeEach(reset);

  it('resets pending actions to empty', async () => {
    pendingActions = [{ type: 'click' }, { type: 'type' }];
    const result = await handle({ type: 'RECORDING_CLEAR' });
    assert.equal(result.ok, true);
    assert.deepStrictEqual(pendingActions, []);
  });
});

describe('SERVICE WORKER: RECORDING_RENAME', () => {
  beforeEach(reset);

  it('updates the recording name', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({ type: 'RECORDING_CREATE', name: 'Old Name' });
    const result = await handle({
      type: 'RECORDING_RENAME',
      recording_id: recording.recording_id,
      name: 'New Name',
    });
    assert.equal(result.ok, true);
    assert.equal(getActiveRecording().name, 'New Name');
  });

  it('returns error for unknown recording_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const result = await handle({ type: 'RECORDING_RENAME', recording_id: 'bad-id', name: 'X' });
    assert.equal(result.ok, false);
  });
});

describe('SERVICE WORKER: STEP_COMMIT', () => {
  beforeEach(reset);

  it('creates a step with narration fields (narration mode)', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({
      type: 'STEP_COMMIT',
      narration: 'Click login',
      narration_source: 'typed',
    });
    assert.equal(result.ok, true);
    assert.equal(result.step.narration, 'Click login');
    assert.equal(result.step.narration_source, 'typed');
    assert.equal(result.step.step_type, undefined);
    assert.equal(result.activeSteps.length, 1);
  });

  it('creates a step with step_type and expect (simple mode)', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({
      type: 'STEP_COMMIT',
      step_type: 'validation',
      expect: 'present',
    });
    assert.equal(result.ok, true);
    assert.equal(result.step.step_type, 'validation');
    assert.equal(result.step.expect, 'present');
    assert.equal(result.step.narration, undefined);
  });

  it('creates action step without expect field', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({ type: 'STEP_COMMIT', step_type: 'action' });
    assert.equal(result.ok, true);
    assert.equal(result.step.step_type, 'action');
    assert.equal(result.step.expect, undefined);
  });

  it('rejects commit with no pending actions and no logical_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [];

    const result = await handle({
      type: 'STEP_COMMIT',
      narration: 'test',
      narration_source: 'typed',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /No actions/);
  });

  it('clears pending actions after commit', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    await handle({ type: 'STEP_COMMIT', step_type: 'action' });
    assert.deepStrictEqual(pendingActions, []);
  });
});

describe('SERVICE WORKER: STEPS_REORDER', () => {
  beforeEach(reset);

  it('reassigns step_number based on new order', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });

    // Create 3 steps with delays to ensure UUID ordering
    pendingActions = [{ type: 'click', timestamp: 1 }];
    const { step: s1 } = await handle({ type: 'STEP_COMMIT', step_type: 'action' });
    await new Promise((r) => setTimeout(r, 2));
    pendingActions = [{ type: 'click', timestamp: 2 }];
    const { step: s2 } = await handle({ type: 'STEP_COMMIT', step_type: 'action' });
    await new Promise((r) => setTimeout(r, 2));
    pendingActions = [{ type: 'click', timestamp: 3 }];
    const { step: s3 } = await handle({ type: 'STEP_COMMIT', step_type: 'action' });

    // Delay before reorder to ensure new UUIDs are higher
    await new Promise((r) => setTimeout(r, 2));

    // Reorder: 3, 1, 2
    const result = await handle({
      type: 'STEPS_REORDER',
      orderedLogicalIds: [s3.logical_id, s1.logical_id, s2.logical_id],
    });

    assert.equal(result.ok, true);
    // After reorder, steps sorted by step_number should be s3(1), s1(2), s2(3)
    const byNumber = result.activeSteps.sort((a, b) => a.step_number - b.step_number);
    assert.equal(byNumber[0].logical_id, s3.logical_id);
    assert.equal(byNumber[0].step_number, 1);
    assert.equal(byNumber[1].logical_id, s1.logical_id);
    assert.equal(byNumber[1].step_number, 2);
    assert.equal(byNumber[2].logical_id, s2.logical_id);
    assert.equal(byNumber[2].step_number, 3);
  });
});

// ─── Content Script → Service Worker Integration ──────────────────────────────
// Tests the APPEND_ACTION handoff: content script sends an action,
// service worker appends to pendingActions and increments pendingCount.

describe('SERVICE WORKER: APPEND_ACTION (content script → storage handoff)', () => {
  // Replicate the appendSwAction logic from the service worker
  let storageData;
  let writeQueue;

  function resetStorage() {
    storageData = { pendingActions: [], pendingCount: 0, recording: true };
    writeQueue = Promise.resolve();
  }

  async function appendSwAction(action) {
    writeQueue = writeQueue.then(async () => {
      const pendingActions = storageData.pendingActions ?? [];
      const updated = [...pendingActions, action];
      storageData.pendingActions = updated;
      storageData.pendingCount = updated.length;
    });
    return writeQueue;
  }

  beforeEach(resetStorage);

  it('appends a single action to pendingActions', async () => {
    const action = { type: 'click', timestamp: 1000, element: { text: 'Login' } };
    await appendSwAction(action);

    assert.equal(storageData.pendingActions.length, 1);
    assert.deepStrictEqual(storageData.pendingActions[0], action);
    assert.equal(storageData.pendingCount, 1);
  });

  it('appends multiple actions in order', async () => {
    const a1 = { type: 'click', timestamp: 1000 };
    const a2 = { type: 'type', timestamp: 1100, value: 'hello' };
    const a3 = { type: 'key', timestamp: 1200, key: 'Enter' };

    await appendSwAction(a1);
    await appendSwAction(a2);
    await appendSwAction(a3);

    assert.equal(storageData.pendingActions.length, 3);
    assert.deepStrictEqual(storageData.pendingActions[0], a1);
    assert.deepStrictEqual(storageData.pendingActions[1], a2);
    assert.deepStrictEqual(storageData.pendingActions[2], a3);
    assert.equal(storageData.pendingCount, 3);
  });

  it('concurrent appends are serialized (no race conditions)', async () => {
    // Fire 10 appends concurrently — all should land in order
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(appendSwAction({ type: 'click', timestamp: i, index: i }));
    }
    await Promise.all(promises);

    assert.equal(storageData.pendingActions.length, 10);
    assert.equal(storageData.pendingCount, 10);
    // Verify order is preserved (queue serializes)
    for (let i = 0; i < 10; i++) {
      assert.equal(storageData.pendingActions[i].index, i);
    }
  });

  it('pendingCount always equals pendingActions.length', async () => {
    await appendSwAction({ type: 'click', timestamp: 1 });
    assert.equal(storageData.pendingCount, storageData.pendingActions.length);

    await appendSwAction({ type: 'type', timestamp: 2 });
    assert.equal(storageData.pendingCount, storageData.pendingActions.length);

    await appendSwAction({ type: 'key', timestamp: 3 });
    assert.equal(storageData.pendingCount, storageData.pendingActions.length);
  });

  it('appending after clear starts fresh', async () => {
    await appendSwAction({ type: 'click', timestamp: 1 });
    await appendSwAction({ type: 'click', timestamp: 2 });

    // Simulate clear (same as RECORDING_CLEAR)
    storageData.pendingActions = [];
    storageData.pendingCount = 0;

    await appendSwAction({ type: 'type', timestamp: 3, value: 'new' });

    assert.equal(storageData.pendingActions.length, 1);
    assert.equal(storageData.pendingActions[0].type, 'type');
    assert.equal(storageData.pendingCount, 1);
  });

  it('action object is stored as-is (no field stripping or mutation)', async () => {
    const action = {
      type: 'click',
      timestamp: 1000,
      capture_mode: 'dom',
      context_id: 42,
      element: { text: 'Submit', selector: '#btn', tag: 'BUTTON', id: 'btn' },
      frame_src: 'https://example.com/frame',
      window_rect: null,
      x: 150,
      y: 300,
    };

    await appendSwAction(action);

    assert.deepStrictEqual(storageData.pendingActions[0], action);
  });
});

// ─── Error Recovery Paths ─────────────────────────────────────────────────────

describe('SERVICE WORKER: error recovery — storage failures', () => {
  beforeEach(reset);

  it('STEP_COMMIT with no active recording returns descriptive error', async () => {
    // No project or recording created
    pendingActions = [{ type: 'click', timestamp: 1 }];
    const result = await handle({
      type: 'STEP_COMMIT',
      narration: 'test',
      narration_source: 'typed',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('No active recording'));
  });

  it('PROJECT_SET_METADATA with no active project returns error', async () => {
    const result = await handle({ type: 'PROJECT_SET_METADATA', metadata: { x: '1' } });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('No active project'));
  });

  it('RECORDING_SET_METADATA with no active project returns error', async () => {
    const result = await handle({
      type: 'RECORDING_SET_METADATA',
      recording_id: 'bad',
      metadata: {},
    });
    assert.equal(result.ok, false);
  });

  it('STEPS_REORDER with no active recording returns error', async () => {
    const result = await handle({ type: 'STEPS_REORDER', orderedLogicalIds: [] });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('No active recording'));
  });

  it('unknown message type returns error', async () => {
    const result = await handle({ type: 'TOTALLY_INVALID_TYPE' });
    assert.equal(result.ok, false);
  });
});
