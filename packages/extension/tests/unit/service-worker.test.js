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
    case 'PROJECTS_LIST': {
      return {
        ok: true,
        projects: projects.map((p) => ({
          project_id: p.project_id,
          name: p.name,
          created_at: p.created_at,
          recording_count: p.recordings.length,
        })),
      };
    }

    case 'PROJECTS_GET_ALL': {
      return { ok: true, projects };
    }

    case 'PROJECTS_SET': {
      projects = msg.projects;
      return { ok: true };
    }

    case 'PROJECT_CREATE': {
      const project = createProject(msg.name);
      projects.push(project);
      activeProjectId = project.project_id;
      activeRecordingId = null;
      return { ok: true, project };
    }

    case 'PROJECT_OPEN': {
      const project = projects.find((p) => p.project_id === msg.project_id);
      if (!project) return { ok: false, error: 'Project not found' };
      activeProjectId = project.project_id;
      activeRecordingId = null;
      return { ok: true, project };
    }

    case 'PROJECT_GET': {
      return { ok: true, project: getActiveProject() };
    }

    case 'PROJECT_DELETE': {
      projects = projects.filter((p) => p.project_id !== msg.project_id);
      if (activeProjectId === msg.project_id) {
        activeProjectId = null;
        activeRecordingId = null;
      }
      return { ok: true };
    }

    case 'PROJECT_RENAME': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      project.name = msg.name;
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

    case 'RECORDING_OPEN': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const recording = findRecording(project, msg.recording_id);
      if (!recording) return { ok: false, error: 'Recording not found' };
      activeRecordingId = recording.recording_id;
      pendingActions = [];
      return { ok: true, recording, activeSteps: resolveActiveSteps(recording) };
    }

    case 'RECORDING_DELETE': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      project.recordings = project.recordings.filter((r) => r.recording_id !== msg.recording_id);
      if (activeRecordingId === msg.recording_id) {
        activeRecordingId = null;
      }
      return { ok: true, project };
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

    case 'RECORDING_START': {
      if (!getActiveRecording()) return { ok: false, error: 'No active recording' };
      return { ok: true };
    }

    case 'RECORDING_STOP': {
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

    case 'STEP_DELETE': {
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };
      deleteStep(recording, msg.logical_id);
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    case 'STEPS_REORDER': {
      const recording = getActiveRecording();
      if (!recording) return { ok: false, error: 'No active recording' };
      reorderSteps(recording, msg.orderedLogicalIds);
      return { ok: true, activeSteps: resolveActiveSteps(recording) };
    }

    case 'PROJECT_IMPORT': {
      const { exportData } = msg;
      if (!exportData?.project || !exportData?.recordings) {
        return { ok: false, error: 'Invalid export file' };
      }
      let projectData = exportData.project;
      const existing = projects.find((p) => p.project_id === projectData.project_id);
      if (existing) {
        projectData = {
          ...projectData,
          project_id: 'new-id-' + Date.now(),
          name: `${projectData.name} (copy)`,
          created_at: new Date().toISOString(),
        };
      }
      const project = {
        ...projectData,
        recordings: exportData.recordings.map(({ activeSteps: _, ...r }) => r),
      };
      projects.push(project);
      return { ok: true, project };
    }

    case 'PROJECT_EXPORT': {
      const project = getActiveProject();
      if (!project) return { ok: false, error: 'No active project' };
      const exportData = {
        project: {
          project_id: project.project_id,
          name: project.name,
          created_at: project.created_at,
          ...(project.metadata && { metadata: project.metadata }),
        },
        recordings: project.recordings.map((r) => ({
          recording_id: r.recording_id,
          name: r.name,
          created_at: r.created_at,
          ...(r.metadata && { metadata: r.metadata }),
          steps: r.steps,
        })),
      };
      return { ok: true, exportData };
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

// ─── PROJECTS_LIST, PROJECTS_GET_ALL, PROJECTS_SET ────────────────────────────

describe('SERVICE WORKER: PROJECTS_LIST', () => {
  beforeEach(reset);

  it('returns empty list initially', async () => {
    const result = await handle({ type: 'PROJECTS_LIST' });
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.projects, []);
  });

  it('returns project summaries with recording_count', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'A' });
    await handle({ type: 'RECORDING_CREATE', name: 'R1' });
    const result = await handle({ type: 'PROJECTS_LIST' });
    assert.equal(result.projects.length, 1);
    assert.equal(result.projects[0].name, 'A');
    assert.equal(result.projects[0].recording_count, 1);
    assert.ok(result.projects[0].project_id);
    assert.ok(result.projects[0].created_at);
  });
});

describe('SERVICE WORKER: PROJECTS_GET_ALL and PROJECTS_SET', () => {
  beforeEach(reset);

  it('GET_ALL returns full project objects', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Full' });
    const result = await handle({ type: 'PROJECTS_GET_ALL' });
    assert.equal(result.ok, true);
    assert.equal(result.projects.length, 1);
    assert.ok(result.projects[0].recordings);
  });

  it('PROJECTS_SET replaces all projects', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Old' });
    const replacement = [{ project_id: 'x', name: 'New', created_at: 'now', recordings: [] }];
    const result = await handle({ type: 'PROJECTS_SET', projects: replacement });
    assert.equal(result.ok, true);
    const all = await handle({ type: 'PROJECTS_GET_ALL' });
    assert.equal(all.projects.length, 1);
    assert.equal(all.projects[0].name, 'New');
  });
});

// ─── PROJECT_OPEN, PROJECT_GET, PROJECT_DELETE, PROJECT_RENAME ────────────────

describe('SERVICE WORKER: PROJECT_OPEN', () => {
  beforeEach(reset);

  it('switches active project', async () => {
    const { project: p1 } = await handle({ type: 'PROJECT_CREATE', name: 'First' });
    await handle({ type: 'PROJECT_CREATE', name: 'Second' });
    const result = await handle({ type: 'PROJECT_OPEN', project_id: p1.project_id });
    assert.equal(result.ok, true);
    assert.equal(result.project.name, 'First');
    const get = await handle({ type: 'PROJECT_GET' });
    assert.equal(get.project.name, 'First');
  });

  it('returns error for invalid project_id', async () => {
    const result = await handle({ type: 'PROJECT_OPEN', project_id: 'bad' });
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/i);
  });
});

describe('SERVICE WORKER: PROJECT_DELETE', () => {
  beforeEach(reset);

  it('removes project and clears active if deleted', async () => {
    const { project } = await handle({ type: 'PROJECT_CREATE', name: 'X' });
    await handle({ type: 'PROJECT_DELETE', project_id: project.project_id });
    const list = await handle({ type: 'PROJECTS_LIST' });
    assert.equal(list.projects.length, 0);
    const get = await handle({ type: 'PROJECT_GET' });
    assert.equal(get.project, null);
  });

  it('does not clear active when deleting non-active project', async () => {
    const { project: p1 } = await handle({ type: 'PROJECT_CREATE', name: 'Keep' });
    await handle({ type: 'PROJECT_CREATE', name: 'Active' });
    await handle({ type: 'PROJECT_DELETE', project_id: p1.project_id });
    const get = await handle({ type: 'PROJECT_GET' });
    assert.equal(get.project.name, 'Active');
  });
});

describe('SERVICE WORKER: PROJECT_RENAME', () => {
  beforeEach(reset);

  it('renames the active project', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Old' });
    const result = await handle({ type: 'PROJECT_RENAME', name: 'New' });
    assert.equal(result.ok, true);
    assert.equal(result.project.name, 'New');
  });

  it('returns error with no active project', async () => {
    const result = await handle({ type: 'PROJECT_RENAME', name: 'X' });
    assert.equal(result.ok, false);
  });
});

// ─── RECORDING_OPEN, RECORDING_DELETE, RECORDING_START, RECORDING_STOP ────────

describe('SERVICE WORKER: RECORDING_OPEN', () => {
  beforeEach(reset);

  it('switches active recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording: r1 } = await handle({ type: 'RECORDING_CREATE', name: 'R1' });
    await handle({ type: 'RECORDING_CREATE', name: 'R2' });
    const result = await handle({ type: 'RECORDING_OPEN', recording_id: r1.recording_id });
    assert.equal(result.ok, true);
    assert.equal(result.recording.name, 'R1');
    assert.ok(Array.isArray(result.activeSteps));
  });

  it('returns error for invalid recording_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const result = await handle({ type: 'RECORDING_OPEN', recording_id: 'bad' });
    assert.equal(result.ok, false);
  });

  it('returns error with no active project', async () => {
    const result = await handle({ type: 'RECORDING_OPEN', recording_id: 'any' });
    assert.equal(result.ok, false);
  });
});

describe('SERVICE WORKER: RECORDING_DELETE', () => {
  beforeEach(reset);

  it('removes recording from project', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({ type: 'RECORDING_CREATE', name: 'R' });
    const result = await handle({ type: 'RECORDING_DELETE', recording_id: recording.recording_id });
    assert.equal(result.ok, true);
    assert.equal(result.project.recordings.length, 0);
  });

  it('clears activeRecordingId when deleting active recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({ type: 'RECORDING_CREATE', name: 'R' });
    await handle({ type: 'RECORDING_DELETE', recording_id: recording.recording_id });
    assert.equal(activeRecordingId, null);
  });

  it('returns error with no active project', async () => {
    const result = await handle({ type: 'RECORDING_DELETE', recording_id: 'any' });
    assert.equal(result.ok, false);
  });
});

describe('SERVICE WORKER: RECORDING_START and RECORDING_STOP', () => {
  beforeEach(reset);

  it('RECORDING_START succeeds with active recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    const result = await handle({ type: 'RECORDING_START' });
    assert.equal(result.ok, true);
  });

  it('RECORDING_START fails with no active recording', async () => {
    const result = await handle({ type: 'RECORDING_START' });
    assert.equal(result.ok, false);
    assert.match(result.error, /No active recording/);
  });

  it('RECORDING_STOP always succeeds', async () => {
    const result = await handle({ type: 'RECORDING_STOP' });
    assert.equal(result.ok, true);
  });
});

// ─── STEP_DELETE ──────────────────────────────────────────────────────────────

describe('SERVICE WORKER: STEP_DELETE', () => {
  beforeEach(reset);

  it('deletes step by logical_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];
    const { step } = await handle({ type: 'STEP_COMMIT', step_type: 'action' });
    // Delay to ensure deleteStep's UUID is strictly greater (UUIDv7 is time-based)
    await new Promise((r) => setTimeout(r, 2));
    const result = await handle({ type: 'STEP_DELETE', logical_id: step.logical_id });
    assert.equal(result.ok, true);
    assert.equal(result.activeSteps.length, 0);
  });

  it('returns error with no active recording', async () => {
    const result = await handle({ type: 'STEP_DELETE', logical_id: 'any' });
    assert.equal(result.ok, false);
  });
});

// ─── PROJECT_IMPORT and PROJECT_EXPORT ────────────────────────────────────────

describe('SERVICE WORKER: PROJECT_IMPORT', () => {
  beforeEach(reset);

  it('imports a new project', async () => {
    const exportData = {
      project: { project_id: 'imp-1', name: 'Imported', created_at: '2026-01-01T00:00:00Z' },
      recordings: [
        { recording_id: 'r-1', name: 'Rec', created_at: '2026-01-01T00:00:00Z', steps: [] },
      ],
    };
    const result = await handle({ type: 'PROJECT_IMPORT', exportData });
    assert.equal(result.ok, true);
    assert.equal(result.project.name, 'Imported');
  });

  it('creates copy when project_id already exists', async () => {
    const { project } = await handle({ type: 'PROJECT_CREATE', name: 'Existing' });
    const exportData = {
      project: {
        project_id: project.project_id,
        name: 'Existing',
        created_at: '2026-01-01T00:00:00Z',
      },
      recordings: [],
    };
    const result = await handle({ type: 'PROJECT_IMPORT', exportData });
    assert.equal(result.ok, true);
    assert.match(result.project.name, /\(copy\)/);
    assert.notEqual(result.project.project_id, project.project_id);
  });

  it('returns error for invalid export data', async () => {
    const result = await handle({ type: 'PROJECT_IMPORT', exportData: { invalid: true } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid export file/);
  });

  it('returns error for null export data', async () => {
    const result = await handle({ type: 'PROJECT_IMPORT', exportData: null });
    assert.equal(result.ok, false);
  });
});

describe('SERVICE WORKER: PROJECT_EXPORT', () => {
  beforeEach(reset);

  it('exports active project with recordings and steps', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Export' });
    await handle({ type: 'RECORDING_CREATE', name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];
    await handle({ type: 'STEP_COMMIT', narration: 'Step', narration_source: 'typed' });

    const result = await handle({ type: 'PROJECT_EXPORT' });
    assert.equal(result.ok, true);
    assert.equal(result.exportData.project.name, 'Export');
    assert.equal(result.exportData.recordings.length, 1);
    assert.equal(result.exportData.recordings[0].steps.length, 1);
  });

  it('includes metadata in export when set', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Meta' });
    await handle({ type: 'PROJECT_SET_METADATA', metadata: { ticket: 'T-1' } });
    const result = await handle({ type: 'PROJECT_EXPORT' });
    assert.deepStrictEqual(result.exportData.project.metadata, { ticket: 'T-1' });
  });

  it('returns error with no active project', async () => {
    const result = await handle({ type: 'PROJECT_EXPORT' });
    assert.equal(result.ok, false);
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
