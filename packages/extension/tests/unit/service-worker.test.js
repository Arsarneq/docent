/**
 * service-worker.test.js — Unit tests for service worker message handlers.
 *
 * The worker imports under the runner behind a fake `chrome` global
 * (`auto-sync-host.test.js` and `service-worker-navigation.test.js` drive it
 * that way), but it exports
 * nothing: its message handlers close over module-private state. So this suite
 * replicates the core message handler logic and tests it with mocked state —
 * the append chokepoint's and the active-unit helpers' copies held to the
 * shipped text by `service-worker-mirror-parity.test.js`, the rest of the
 * replica pinning only itself (docs/test/unit.md). The last block imports the
 * shipped worker that way instead and drives its listener, for the messages a
 * panel sends while another panel holds the worker's active project. That
 * block holds how the worker resolves each project- and recording-scoped
 * message; the replica's cases send those messages only as the panel showing
 * the active project and recording sends them.
 *
 * Uses Node.js built-in test runner.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
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
import { isTrustedActionSender } from '../../lib/frame-trust.js';
import { keyEntersText, redactSensitive, repeatsMaskedEntry } from '../../lib/redaction-logic.js';
import { END_TYPING_BOUND } from '../../lib/capture-timing.js';
import { SENSITIVE_MASK } from '../../shared/lib/field-sensitivity.js';
import { composePlatform, locatorStrategyDefs } from '../../../../scripts/build-schemas.js';
import { valueDerivedStrategies } from '../../../../scripts/sufficiency-lint.js';

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

// The ids of the active project and recording, as the panel showing them sends
// them with a scoped message (extension runtime, Panel protocol).
const activeIds = () => ({ project_id: activeProjectId, recording_id: activeRecordingId });

// Verbatim copies of the worker's active-unit helpers, held by service-worker-mirror-parity.test.js
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
      const project = projects.find((p) => p.project_id === msg.project_id);
      if (!project) return { ok: false, error: 'Project not found' };
      return { ok: true, project };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SERVICE WORKER: RECORDING_CLEAR', () => {
  beforeEach(reset);

  it('resets pending actions to empty', async () => {
    pendingActions = [{ type: 'click' }, { type: 'type' }];
    const result = await handle({ type: 'RECORDING_CLEAR' });
    assert.equal(result.ok, true);
    assert.deepStrictEqual(pendingActions, []);
  });
});

describe('SERVICE WORKER: STEP_COMMIT', () => {
  beforeEach(reset);

  it('creates a step with narration fields (narration mode)', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({
      type: 'STEP_COMMIT',
      ...activeIds(),
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
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({
      type: 'STEP_COMMIT',
      ...activeIds(),
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
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    const result = await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });
    assert.equal(result.ok, true);
    assert.equal(result.step.step_type, 'action');
    assert.equal(result.step.expect, undefined);
  });

  it('rejects commit with no pending actions and no logical_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [];

    const result = await handle({
      type: 'STEP_COMMIT',
      ...activeIds(),
      narration: 'test',
      narration_source: 'typed',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /No actions/);
  });

  it('clears pending actions after commit', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];

    await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });
    assert.deepStrictEqual(pendingActions, []);
  });
});

describe('SERVICE WORKER: STEPS_REORDER', () => {
  beforeEach(reset);

  it('reassigns step_number based on new order', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });

    // Create 3 steps with delays to ensure UUID ordering
    pendingActions = [{ type: 'click', timestamp: 1 }];
    const { step: s1 } = await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });
    await new Promise((r) => setTimeout(r, 2));
    pendingActions = [{ type: 'click', timestamp: 2 }];
    const { step: s2 } = await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });
    await new Promise((r) => setTimeout(r, 2));
    pendingActions = [{ type: 'click', timestamp: 3 }];
    const { step: s3 } = await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });

    // Delay before reorder to ensure new UUIDs are higher
    await new Promise((r) => setTimeout(r, 2));

    // Reorder: 3, 1, 2
    const result = await handle({
      type: 'STEPS_REORDER',
      ...activeIds(),
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
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R1' });
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
    assert.equal(activeProjectId, p1.project_id);
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
    assert.equal(activeProjectId, null);
  });

  it('does not clear active when deleting non-active project', async () => {
    const { project: p1 } = await handle({ type: 'PROJECT_CREATE', name: 'Keep' });
    const { project: active } = await handle({ type: 'PROJECT_CREATE', name: 'Active' });
    await handle({ type: 'PROJECT_DELETE', project_id: p1.project_id });
    assert.equal(activeProjectId, active.project_id);
  });
});

// ─── RECORDING_OPEN, RECORDING_DELETE, RECORDING_START, RECORDING_STOP ────────

describe('SERVICE WORKER: RECORDING_DELETE', () => {
  beforeEach(reset);

  it('clears activeRecordingId when deleting active recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await handle({
      type: 'RECORDING_CREATE',
      project_id: activeProjectId,
      name: 'R',
    });
    await handle({
      type: 'RECORDING_DELETE',
      project_id: activeProjectId,
      recording_id: recording.recording_id,
    });
    assert.equal(activeRecordingId, null);
  });
});

describe('SERVICE WORKER: RECORDING_START and RECORDING_STOP', () => {
  beforeEach(reset);

  it('RECORDING_START succeeds with active recording', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    const result = await handle({ type: 'RECORDING_START', ...activeIds() });
    assert.equal(result.ok, true);
  });

  it('RECORDING_START fails with no active recording', async () => {
    const result = await handle({ type: 'RECORDING_START' });
    assert.equal(result.ok, false);
    assert.match(result.error, /No active recording/);
  });
});

// ─── STEP_DELETE ──────────────────────────────────────────────────────────────

describe('SERVICE WORKER: STEP_DELETE', () => {
  beforeEach(reset);

  it('deletes step by logical_id', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'P' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];
    const { step } = await handle({ type: 'STEP_COMMIT', ...activeIds(), step_type: 'action' });
    // Delay to ensure deleteStep's UUID is strictly greater (UUIDv7 is time-based)
    await new Promise((r) => setTimeout(r, 2));
    const result = await handle({
      type: 'STEP_DELETE',
      ...activeIds(),
      logical_id: step.logical_id,
    });
    assert.equal(result.ok, true);
    assert.equal(result.activeSteps.length, 0);
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

  it('returns the project named by its id, with recordings and steps', async () => {
    const { project } = await handle({ type: 'PROJECT_CREATE', name: 'Export' });
    await handle({ type: 'RECORDING_CREATE', project_id: activeProjectId, name: 'R' });
    pendingActions = [{ type: 'click', timestamp: 1 }];
    await handle({
      type: 'STEP_COMMIT',
      ...activeIds(),
      narration: 'Step',
      narration_source: 'typed',
    });

    const result = await handle({ type: 'PROJECT_EXPORT', project_id: project.project_id });
    assert.equal(result.ok, true);
    assert.equal(result.project.name, 'Export');
    assert.equal(result.project.recordings.length, 1);
    assert.equal(result.project.recordings[0].steps.length, 1);
  });

  it('returns the named project, not the worker-wide active one', async () => {
    const { project: named } = await handle({ type: 'PROJECT_CREATE', name: 'Named' });
    await handle({ type: 'PROJECT_CREATE', name: 'Active' });
    const result = await handle({ type: 'PROJECT_EXPORT', project_id: named.project_id });
    assert.equal(result.project.name, 'Named');
  });

  it('includes metadata in the returned project when set', async () => {
    const { project } = await handle({ type: 'PROJECT_CREATE', name: 'Meta' });
    await handle({
      type: 'PROJECT_SET_METADATA',
      project_id: project.project_id,
      metadata: { ticket: 'T-1' },
    });
    const result = await handle({ type: 'PROJECT_EXPORT', project_id: project.project_id });
    assert.deepStrictEqual(result.project.metadata, { ticket: 'T-1' });
  });

  it('returns Project not found for an id it does not hold, or none', async () => {
    await handle({ type: 'PROJECT_CREATE', name: 'Active' });
    for (const message of [
      { type: 'PROJECT_EXPORT', project_id: 'missing' },
      { type: 'PROJECT_EXPORT' },
    ]) {
      assert.deepEqual(await handle(message), { ok: false, error: 'Project not found' });
    }
  });
});

// ─── Redaction chokepoint (locator masking) ────────────────────────────────────
// Exercises the REAL redactSensitive from lib/redaction-logic.js (extracted
// from the service worker so this suite needs no hand-copied replica).
// Locator masking is IN PLACE: the entry is kept, its value masked with the
// shared glyphs, `masked: true` set, and the match statistics (measured
// pre-masking at capture) left untouched.

describe('SERVICE WORKER: redactSensitive masks value-derived locator entries in place', () => {
  function sensitiveAction() {
    return {
      type: 'type',
      timestamp: 1000,
      value: '4111 1111 1111 1111',
      element: {
        tag: 'INPUT',
        id: 'card_number',
        name: 'card_number',
        type: 'text',
        text: '4111 1111 1111 1111',
        selector: '#card_number',
        locators: [
          { strategy: 'id', value: 'card_number', match_count: 1, match_index: 0 },
          { strategy: 'name', value: 'card_number', match_count: 1, match_index: 0 },
          { strategy: 'tag_name', value: 'input', match_count: 3, match_index: 1 },
          { strategy: 'text', value: '4111 1111 1111 1111', match_count: 2, match_index: 0 },
          { strategy: 'css', value: '#card_number', match_count: 1, match_index: 0 },
        ],
      },
    };
  }

  it('masks the text entry in place, keeping the pre-masking pair', () => {
    const action = redactSensitive(sensitiveAction());
    const textEntry = action.element.locators.find((l) => l.strategy === 'text');
    assert.equal(textEntry.value, SENSITIVE_MASK);
    assert.equal(textEntry.masked, true);
    assert.equal(textEntry.match_count, 2);
    assert.equal(textEntry.match_index, 0);
    assert.equal(action.element.locators.length, 5, 'entries are never omitted');
  });

  it('never masks identity-derived entries', () => {
    const action = redactSensitive(sensitiveAction());
    for (const strategy of ['id', 'name', 'tag_name', 'css']) {
      const entry = action.element.locators.find((l) => l.strategy === strategy);
      assert.notEqual(entry.value, SENSITIVE_MASK, `${strategy} must not be masked`);
      assert.equal(entry.masked, undefined);
    }
  });

  it('leaves a non-sensitive element and its locators untouched', () => {
    const action = {
      type: 'click',
      element: {
        tag: 'BUTTON',
        id: 'save',
        name: 'save',
        type: 'button',
        text: 'Save',
        selector: '#save',
        locators: [{ strategy: 'text', value: 'Save', match_count: 3, match_index: 1 }],
      },
    };
    const out = redactSensitive(action);
    assert.equal(out.element.locators[0].value, 'Save');
    assert.equal(out.element.locators[0].masked, undefined);
    assert.equal(out.element.redacted, undefined);
  });

  it('tolerates an element without locators', () => {
    const action = {
      type: 'type',
      value: 'secret',
      element: { tag: 'INPUT', id: 'ssn', name: 'ssn', type: 'text', text: 'x' },
    };
    const out = redactSensitive(action);
    assert.equal(out.element.redacted, true);
    assert.equal(out.value, SENSITIVE_MASK);
  });

  it("drift guard: the masked set equals the schema's x-value-derived strategies", () => {
    // The schema annotates which strategies the redaction chokepoint masks in
    // place (`x-value-derived`). This drives the REAL redactSensitive on a
    // sensitive element carrying one entry per emitted strategy and checks the
    // two sides of the seam against each other — if the code starts masking a
    // strategy the schema does not annotate (or stops masking one it does),
    // this fails, forcing annotation and behaviour to move together. The
    // annotated set comes from valueDerivedStrategies — the exact reader the
    // sufficiency lint's masked-locator-honesty predicate enforces — so the
    // guard pins the code against the set the lint actually uses.
    const defs = locatorStrategyDefs(composePlatform('extension')).map(({ def }) => def);
    const annotated = [...valueDerivedStrategies('extension')];

    const action = redactSensitive({
      type: 'type',
      value: '4111 1111 1111 1111',
      element: {
        tag: 'INPUT',
        id: 'card_number',
        name: 'card_number',
        type: 'text',
        text: '4111 1111 1111 1111',
        selector: '#card_number',
        locators: defs.map((def) => ({
          strategy: def.properties.strategy.const,
          value: `value-${def.properties.strategy.const}`,
          match_count: 1,
          match_index: 0,
        })),
      },
    });

    const maskedStrategies = action.element.locators
      .filter((loc) => loc.masked === true)
      .map((loc) => loc.strategy);
    assert.deepStrictEqual(maskedStrategies.sort(), [...annotated].sort());
    for (const loc of action.element.locators) {
      if (loc.masked === true) {
        assert.equal(loc.value, SENSITIVE_MASK, `${loc.strategy} masked but value not the mask`);
      } else {
        assert.equal(loc.value, `value-${loc.strategy}`, `${loc.strategy} value must be verbatim`);
      }
      assert.equal(loc.match_count, 1, `${loc.strategy} match stats must survive masking`);
      assert.equal(loc.match_index, 0, `${loc.strategy} match stats must survive masking`);
    }
  });
});

// Regression: #702 — every key press that is not text is written, so a key
// that enters a character can be pressed on a sensitive field that takes no
// text from it. Its name is the character: it is recorded as the field's
// masked `type`, as the desktop records it.
// https://github.com/Arsarneq/docent/issues/702
describe('SERVICE WORKER: a key that enters a character on a sensitive field is a masked type', () => {
  const MASK = '••••••••';
  const none = { ctrl: false, shift: false, alt: false, meta: false };
  const card = () => ({ tag: 'INPUT', type: 'text', name: 'card-number', selector: '#card' });
  const key = (name, element, modifiers = none, code = 'Digit4') => ({
    type: 'key',
    timestamp: 1,
    context_id: 7,
    key: name,
    modifiers,
    repeat: false,
    code,
    held_keys: [],
    element,
  });

  it('regression_237_a_character_key_that_becomes_the_masked_type_loses_its_input_method_fields', () => {
    // The fields belong to a `key` action; the masked `type` is none.
    const withState = (action) => ({
      ...action,
      input_method_open: true,
      input_method_conversion_mode: 9,
    });
    const out = redactSensitive(withState(key('4', card())));
    assert.equal(out.type, 'type');
    assert.equal('input_method_open' in out, false);
    assert.equal('input_method_conversion_mode' in out, false);
    // A key that stays a key keeps them.
    const enter = redactSensitive(withState(key('Enter', card(), none, 'NumpadEnter')));
    assert.equal(enter.input_method_open, true);
    assert.equal(enter.input_method_conversion_mode, 9);
  });

  it('regression_717_a_character_key_that_becomes_the_masked_type_loses_its_code', () => {
    // `code` names the physical key, which says as much as the character.
    const out = redactSensitive(key('4', card()));
    assert.equal(out.type, 'type');
    assert.equal('code' in out, false);
    // A key that stays a key keeps it.
    assert.equal(redactSensitive(key('Enter', card(), none, 'NumpadEnter')).code, 'NumpadEnter');
  });

  it('regression_702_a_character_key_becomes_the_masked_type_and_loses_its_key_fields', () => {
    for (const name of ['4', 'a', 'Space', 'Dead', 'å']) {
      const out = redactSensitive(key(name, card()));
      assert.equal(out.type, 'type', name);
      assert.equal(out.value, MASK, name);
      assert.equal(out.element.redacted, true, name);
      for (const field of ['key', 'modifiers', 'repeat', 'held_keys']) {
        assert.equal(field in out, false, `${name}: ${field}`);
      }
    }
  });

  it('regression_702_a_key_that_enters_no_character_and_a_shortcut_stay_keys', () => {
    for (const name of ['Enter', 'Backspace', 'ArrowLeft', 'F5', 'Tab']) {
      assert.equal(redactSensitive(key(name, card())).type, 'key', name);
    }
    assert.equal(redactSensitive(key('v', card(), { ...none, ctrl: true })).type, 'key');
    assert.equal(redactSensitive(key('v', card(), { ...none, meta: true })).type, 'key');
    // Ctrl and Alt together is AltGr: a character.
    assert.equal(
      redactSensitive(key('@', card(), { ...none, ctrl: true, alt: true })).type,
      'type',
    );
  });

  it('regression_702_a_key_on_a_control_that_takes_no_text_stays_a_key_whatever_it_is_named', () => {
    const controls = [
      { tag: 'BUTTON', name: 'show-password' },
      { tag: 'A', name: 'password-reset' },
      { tag: 'SUMMARY', name: 'card-number' },
      { tag: 'INPUT', type: 'checkbox', name: 'remember-password' },
      { tag: 'INPUT', type: 'radio', name: 'card-number' },
      { tag: 'INPUT', type: 'submit', name: 'password' },
      { tag: 'DIV', role: 'button', name: 'password' },
    ];
    for (const element of controls) {
      const out = redactSensitive(key('Space', { ...element, selector: '#x' }));
      assert.equal(out.type, 'key', JSON.stringify(element));
      assert.equal(out.key, 'Space');
    }
  });

  it('regression_702_a_character_key_on_a_sensitive_list_is_masked_as_the_desktop_masks_it', () => {
    // The desktop's controls that take no typed text hold no list: a letter
    // pressed on a list picks the option that starts with it.
    for (const element of [
      { tag: 'SELECT', name: 'card-number' },
      { tag: 'DIV', role: 'option', name: 'card-number' },
    ]) {
      const out = redactSensitive(key('4', { ...element, selector: '#x' }));
      assert.equal(out.type, 'type', JSON.stringify(element));
    }
  });

  it('regression_702_a_key_on_a_field_that_is_not_sensitive_stays_a_key', () => {
    const out = redactSensitive(
      key('a', { tag: 'INPUT', type: 'text', name: 'city', selector: '#c' }),
    );
    assert.equal(out.type, 'key');
    assert.equal(out.key, 'a');
  });

  it('regression_702_a_character_key_with_alt_alone_is_a_shortcut_and_stays_a_key', () => {
    // Alt with a character key reaches for a menu and enters no character.
    const alt = { ...none, alt: true };
    assert.equal(redactSensitive(key('a', card(), alt)).type, 'key');
    assert.equal(keyEntersText(key('a', card(), alt), false), false);
    // On a Mac it is the Option key, which enters characters of the layout.
    assert.equal(keyEntersText(key('å', card(), alt), true), true);
    assert.equal(keyEntersText(key('v', card(), { ...none, meta: true }), true), false);
  });

  it('regression_702_a_masked_type_that_repeats_the_one_before_it_on_the_same_field_is_not_stored_again', () => {
    const typed = (over = {}) => ({
      type: 'type',
      context_id: 7,
      frame_src: null,
      value: MASK,
      element: { ...card(), redacted: true },
      ...over,
    });
    const first = { ...redactSensitive(key('4', card())), frame_src: null };
    assert.equal(repeatsMaskedEntry(first, typed()), true, 'the entry after a key');
    assert.equal(repeatsMaskedEntry(typed(), first), true, 'a key after the entry');
    assert.equal(repeatsMaskedEntry(typed(), typed()), true, 'two entries in a row');
  });

  it('regression_702_a_masked_type_after_any_other_action_field_frame_or_context_is_stored', () => {
    const typed = (over = {}) => ({
      type: 'type',
      context_id: 7,
      frame_src: null,
      value: MASK,
      element: { ...card(), redacted: true },
      ...over,
    });
    assert.equal(repeatsMaskedEntry(undefined, typed()), false, 'nothing before it');
    assert.equal(
      repeatsMaskedEntry({ type: 'click', context_id: 7, element: card() }, typed()),
      false,
    );
    assert.equal(repeatsMaskedEntry({ type: 'navigate', context_id: 7 }, typed()), false);
    const cvc = { ...card(), selector: '#cvc', redacted: true };
    assert.equal(repeatsMaskedEntry(typed({ element: cvc }), typed()), false, 'another field');
    assert.equal(repeatsMaskedEntry(typed({ context_id: 8 }), typed()), false, 'another context');
    assert.equal(
      repeatsMaskedEntry(typed({ frame_src: 'https://a.test/f' }), typed()),
      false,
      'another frame',
    );
    // A value that is not masked is an entry of its own.
    assert.equal(repeatsMaskedEntry(typed(), typed({ value: 'x' })), false);
    // A field with no selector cannot be told from another.
    const bare = { ...card(), selector: '', redacted: true };
    assert.equal(repeatsMaskedEntry(typed({ element: bare }), typed({ element: bare })), false);
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
      x: 150,
      y: 300,
    };

    await appendSwAction(action);

    assert.deepStrictEqual(storageData.pendingActions[0], action);
  });
});

// ─── APPEND_ACTION sender validation (frame trust) ────────────────────────────
// The SW validates each APPEND_ACTION sender against the active-frame registry
// via the shared frame-trust helper before appending. The chokepoint below is
// the worker's own validateAndAppend, kept here as a second textual copy of it
// (the mirrored-block convention: recorder-mirror-parity.test.js is the
// precedent) — service-worker-mirror-parity.test.js holds the two copies equal
// and fails this suite when they drift, so a case here pins the shipped
// chokepoint rather than a mirror of it. The trust decision routes through the
// REAL isTrustedActionSender for the same reason.

describe('SERVICE WORKER: APPEND_ACTION sender validation', () => {
  const RUNTIME_ID = 'docent-extension-id';
  let storageData;
  let activeFrames;
  let liveRecording;
  let warnings;

  function reset() {
    storageData = { pendingActions: [], pendingCount: 0 };
    activeFrames = new Map();
    liveRecording = true;
    warnings = 0;
  }

  function register(tabId, frameId) {
    let frames = activeFrames.get(tabId);
    if (!frames) {
      frames = new Set();
      activeFrames.set(tabId, frames);
    }
    frames.add(frameId);
  }

  // The seams the worker's module scope supplies, bound here so the copy below
  // can be the worker's text and nothing else: the runtime id the trust
  // predicate reads, the warning sink, what the worker brings back before
  // validating (inert here — a real reseed needs webNavigation, and every case
  // registers the frames it means to be trusted), and the append chokepoint,
  // whose storage and redaction behaviour is pinned by their own suites.
  const chrome = { runtime: { id: RUNTIME_ID } };
  const console = {
    warn: () => {
      warnings++;
    },
  };
  async function restoreWhatSuspensionLost() {}
  // No press is reported in these cases, so no append is held.
  const pressHolds = new Map();
  const pressHoldKey = () => null;
  async function appendSwAction(action) {
    storageData.pendingActions = [...storageData.pendingActions, action];
    storageData.pendingCount = storageData.pendingActions.length;
  }

  // -- BEGIN MIRRORED APPEND CHOKEPOINT (two-copy: background/service-worker.js <-> this suite; parity-tested) --
  async function validateAndAppend(action, sender) {
    // What a frame sends behind its pointer press is stored behind what the
    // press made the tab's other frames write. The hold is read before anything
    // is awaited, so the frame's messages keep their order, and waited on only
    // after the sender test: the sender is judged as its message arrives, while
    // the frame that sent it is still registered (the click that navigates its
    // own frame away, or closes its tab).
    const hold = pressHolds.get(pressHoldKey(sender));

    await restoreWhatSuspensionLost(sender);
    const tabId = sender?.tab?.id;
    const trusted = isTrustedActionSender({
      sender,
      runtimeId: chrome.runtime.id,
      liveRecording,
      activeFrames,
    });
    if (!trusted) {
      console.warn('[Docent] Dropped APPEND_ACTION from untrusted sender', {
        tabId,
        frameId: sender?.frameId,
      });
      return;
    }

    // Stamp identity from the TRUSTED sender, not the message: a compromised frame
    // cannot spoof another tab's context_id. frame_src is left as reported — it is
    // descriptive context (cross-origin tests assert on it) and dropping legitimate
    // frame data would violate the conservative-fidelity rule.
    if (action && typeof action === 'object') {
      action.context_id = sender.tab.id;
    }
    if (hold) await hold;
    await appendSwAction(action);
  }
  // -- END MIRRORED APPEND CHOKEPOINT --

  beforeEach(reset);

  it('appends an action from a trusted, recorded frame', async () => {
    register(7, 0);
    await validateAndAppend(
      { type: 'click', context_id: 7 },
      { id: RUNTIME_ID, frameId: 0, tab: { id: 7 } },
    );
    assert.equal(storageData.pendingActions.length, 1);
    assert.equal(warnings, 0);
  });

  it('drops (does not append) an action from a frame not in the active set', async () => {
    register(7, 0);
    await validateAndAppend({ type: 'click' }, { id: RUNTIME_ID, frameId: 99, tab: { id: 7 } });
    assert.equal(storageData.pendingActions.length, 0);
    assert.equal(warnings, 1);
  });

  it('drops an action from a tab that is not being recorded', async () => {
    register(7, 0);
    await validateAndAppend({ type: 'click' }, { id: RUNTIME_ID, frameId: 0, tab: { id: 999 } });
    assert.equal(storageData.pendingActions.length, 0);
  });

  it('drops an action from a foreign sender id', async () => {
    register(7, 0);
    await validateAndAppend(
      { type: 'click' },
      { id: 'evil-extension', frameId: 0, tab: { id: 7 } },
    );
    assert.equal(storageData.pendingActions.length, 0);
  });

  it('stamps context_id from the trusted sender, overwriting a spoofed value', async () => {
    register(7, 0);
    const action = { type: 'click', context_id: 1234 };
    await validateAndAppend(action, { id: RUNTIME_ID, frameId: 0, tab: { id: 7 } });
    assert.equal(action.context_id, 7);
    assert.equal(storageData.pendingActions[0].context_id, 7);
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
      ...activeIds(),
      narration: 'test',
      narration_source: 'typed',
    });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('No active recording'));
  });

  it('unknown message type returns error', async () => {
    const result = await handle({ type: 'TOTALLY_INVALID_TYPE' });
    assert.equal(result.ok, false);
  });
});

// ─── Two panels open: the shipped worker, driven through its listener ────────
//
// Unlike the replica above, this block imports the shipped worker behind a fake
// `chrome` global with an in-memory `storage.local` (the approach
// `service-worker-navigation.test.js` documents) and sends each message
// through the `onMessage` listener the worker registers, so its verdicts stand
// on the shipped handlers. Each case puts the worker in the state two open side
// panels leave it in: the first panel shows a project and a recording, and the
// second panel then created and opened its own, which moved the worker-wide
// active project and recording to the second panel's. Each message is sent as
// the first panel sends it, naming the project and the recording it shows.

// Regression: #661 — with two side panels open, project- and recording-scoped
// messages acted on the worker's active project and recording, the ones the
// panel that opened one last shows, not the ones the sending panel shows.
// https://github.com/Arsarneq/docent/issues/661
describe('SERVICE WORKER: messages from a panel that is not the last to open a project', () => {
  const NOT_ACTIVE = 'Not the active recording';
  const workerStorage = {};
  let workerOnMessage = null;

  let workerOnTabRemoved;
  const send = (message) => new Promise((resolve) => workerOnMessage(message, {}, resolve));
  const stored = (projectId) => workerStorage.projects.find((p) => p.project_id === projectId);
  const storedRecording = (projectId, recordingId) =>
    findRecording(stored(projectId), recordingId) ?? null;
  const activeStepIds = (projectId, recordingId) =>
    resolveActiveSteps(storedRecording(projectId, recordingId)).map((s) => s.logical_id);
  const capture = (count = 1) => {
    workerStorage.pendingActions = Array.from({ length: count }, (_, i) => ({
      type: 'click',
      timestamp: 1000 + i,
    }));
    workerStorage.pendingCount = count;
  };

  // A step's versions are told apart by their time-ordered ids, so each edit
  // waits for the clock to move on.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

  /** A project with one recording of two committed steps, opened as a panel opens it. */
  async function projectWithSteps(name) {
    const { project } = await send({ type: 'PROJECT_CREATE', name });
    const ids = { project_id: project.project_id };
    const { recording } = await send({ type: 'RECORDING_CREATE', ...ids, name: `${name} rec` });
    ids.recording_id = recording.recording_id;
    for (const narration of ['first', 'second']) {
      capture();
      const committed = await send({ type: 'STEP_COMMIT', ...ids, narration });
      assert.equal(committed.ok, true, 'setup commit');
      await tick();
    }
    return ids;
  }

  let shown; // the project and recording the first panel shows
  let other; // the ones the second panel opened last, the worker's active ones

  before(async () => {
    const noListener = { addListener() {} };
    const getFrom = (keys) => {
      const list = keys == null ? Object.keys(workerStorage) : [].concat(keys);
      return Object.fromEntries(
        list.filter((k) => k in workerStorage).map((k) => [k, workerStorage[k]]),
      );
    };
    globalThis.chrome = {
      runtime: {
        id: 'test-extension',
        onInstalled: noListener,
        onMessage: { addListener: (fn) => (workerOnMessage = fn) },
        getURL: (p) => p,
        sendMessage: async () => ({}),
      },
      action: { onClicked: noListener },
      storage: {
        local: {
          get: async (keys) => getFrom(keys),
          set: async (items) => void Object.assign(workerStorage, structuredClone(items)),
          getBytesInUse: async () => 0,
          remove: async (keys) => [].concat(keys).forEach((k) => delete workerStorage[k]),
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: noListener,
      },
      webNavigation: {
        onCompleted: noListener,
        onCommitted: noListener,
        onBeforeNavigate: noListener,
        getAllFrames: async () => [],
      },
      tabs: {
        onActivated: noListener,
        onCreated: noListener,
        onRemoved: { addListener: (fn) => (workerOnTabRemoved = fn) },
        query: async () => [],
        get: async () => ({}),
      },
      scripting: { executeScript: async () => {} },
      alarms: { create() {}, clear() {}, onAlarm: noListener },
      sidePanel: { open: async () => {} },
    };
    await import('../../background/service-worker.js');
  });

  beforeEach(async () => {
    await send({ type: 'PROJECTS_SET', projects: [] });
    shown = await projectWithSteps('Shown here');
    other = await projectWithSteps('Opened elsewhere');
    // The second panel's recording is capturing, with one action not yet committed.
    capture();
    assert.equal(workerStorage.activeRecordingId, other.recording_id, 'setup: active moved');
    assert.equal(workerStorage.recording, true, 'setup: capturing');
  });

  // ── Messages that edit the model: resolved by the ids they carry ──

  it('regression_661_project_rename_renames_the_project_the_panel_shows', async () => {
    const response = await send({
      type: 'PROJECT_RENAME',
      project_id: shown.project_id,
      name: 'Renamed',
    });
    assert.equal(response.ok, true);
    assert.equal(stored(shown.project_id).name, 'Renamed');
    assert.equal(stored(other.project_id).name, 'Opened elsewhere');
  });

  it('regression_661_project_set_metadata_sets_the_project_the_panel_shows', async () => {
    const metadata = { env: 'staging' };
    const response = await send({
      type: 'PROJECT_SET_METADATA',
      project_id: shown.project_id,
      metadata,
    });
    assert.equal(response.ok, true);
    assert.deepEqual(stored(shown.project_id).metadata, metadata);
    assert.equal(stored(other.project_id).metadata, undefined);
  });

  it('regression_661_project_get_returns_the_project_the_panel_shows', async () => {
    const response = await send({ type: 'PROJECT_GET', project_id: shown.project_id });
    assert.equal(response.ok, true);
    assert.equal(response.project.project_id, shown.project_id);
  });

  it('regression_661_recording_create_creates_in_the_project_the_panel_shows', async () => {
    const response = await send({
      type: 'RECORDING_CREATE',
      project_id: shown.project_id,
      name: 'New',
    });
    assert.equal(response.ok, true);
    assert.equal(response.project.project_id, shown.project_id);
    assert.ok(storedRecording(shown.project_id, response.recording.recording_id));
    assert.equal(stored(other.project_id).recordings.length, 1);
    // The new recording is the one capture now goes to.
    assert.equal(workerStorage.activeProjectId, shown.project_id);
    assert.equal(workerStorage.activeRecordingId, response.recording.recording_id);
  });

  it('regression_661_recording_open_opens_a_recording_of_the_project_the_panel_shows', async () => {
    const response = await send({ type: 'RECORDING_OPEN', ...shown });
    assert.equal(response.ok, true);
    assert.equal(response.recording.recording_id, shown.recording_id);
    assert.equal(workerStorage.activeProjectId, shown.project_id);
    assert.equal(workerStorage.activeRecordingId, shown.recording_id);
  });

  it('regression_661_recording_delete_deletes_from_the_project_the_panel_shows', async () => {
    const response = await send({ type: 'RECORDING_DELETE', ...shown });
    assert.equal(response.ok, true);
    assert.equal(response.project.project_id, shown.project_id);
    assert.equal(storedRecording(shown.project_id, shown.recording_id), null);
    // Not the recording capture goes to, so capture goes on.
    assert.equal(workerStorage.recording, true);
  });

  it('regression_661_recording_rename_renames_in_the_project_the_panel_shows', async () => {
    const response = await send({ type: 'RECORDING_RENAME', ...shown, name: 'Renamed rec' });
    assert.equal(response.ok, true);
    assert.equal(storedRecording(shown.project_id, shown.recording_id).name, 'Renamed rec');
  });

  it('regression_661_recording_set_metadata_sets_in_the_project_the_panel_shows', async () => {
    const metadata = { ticket: 'T-1' };
    const response = await send({ type: 'RECORDING_SET_METADATA', ...shown, metadata });
    assert.equal(response.ok, true);
    assert.deepEqual(storedRecording(shown.project_id, shown.recording_id).metadata, metadata);
  });

  it('regression_661_step_delete_deletes_in_the_recording_the_panel_shows', async () => {
    const [first, second] = activeStepIds(shown.project_id, shown.recording_id);
    const otherSteps = activeStepIds(other.project_id, other.recording_id);
    const response = await send({ type: 'STEP_DELETE', ...shown, logical_id: first });
    assert.equal(response.ok, true);
    assert.deepEqual(
      response.activeSteps.map((s) => s.logical_id),
      [second],
    );
    assert.deepEqual(activeStepIds(shown.project_id, shown.recording_id), [second]);
    assert.deepEqual(activeStepIds(other.project_id, other.recording_id), otherSteps);
  });

  it('regression_661_steps_reorder_reorders_the_recording_the_panel_shows', async () => {
    const [first, second] = activeStepIds(shown.project_id, shown.recording_id);
    const otherSteps = activeStepIds(other.project_id, other.recording_id);
    const response = await send({
      type: 'STEPS_REORDER',
      ...shown,
      orderedLogicalIds: [second, first],
    });
    assert.equal(response.ok, true);
    assert.deepEqual(
      response.activeSteps.map((s) => s.logical_id),
      [second, first],
    );
    assert.deepEqual(activeStepIds(shown.project_id, shown.recording_id), [second, first]);
    assert.deepEqual(activeStepIds(other.project_id, other.recording_id), otherSteps);
  });

  it('answers Project not found for a project id it does not hold, or none', async () => {
    const before = JSON.stringify(workerStorage.projects);
    for (const type of [
      'PROJECT_GET',
      'PROJECT_RENAME',
      'PROJECT_SET_METADATA',
      'RECORDING_CREATE',
      'RECORDING_OPEN',
      'RECORDING_DELETE',
      'RECORDING_RENAME',
      'RECORDING_SET_METADATA',
      'STEP_DELETE',
      'STEPS_REORDER',
    ]) {
      for (const project_id of ['missing', undefined]) {
        const message = { type, project_id, recording_id: shown.recording_id, name: 'X' };
        assert.deepEqual(await send(message), { ok: false, error: 'Project not found' }, type);
      }
    }
    assert.equal(JSON.stringify(workerStorage.projects), before, 'nothing changed');
  });

  it('answers Recording not found for a recording id the named project does not hold, or none', async () => {
    const before = JSON.stringify(workerStorage.projects);
    for (const type of [
      'RECORDING_OPEN',
      'RECORDING_DELETE',
      'RECORDING_RENAME',
      'RECORDING_SET_METADATA',
      'STEP_DELETE',
      'STEPS_REORDER',
    ]) {
      // The other project's recording, named with this panel's project, and no recording.
      for (const recording_id of [other.recording_id, null]) {
        const message = { type, project_id: shown.project_id, recording_id };
        assert.deepEqual(
          await send({ ...message, name: 'X', orderedLogicalIds: [] }),
          { ok: false, error: 'Recording not found' },
          `${type} ${recording_id}`,
        );
      }
    }
    assert.equal(JSON.stringify(workerStorage.projects), before, 'nothing changed');
    assert.equal(workerStorage.recording, true, 'capture goes on');
  });

  // ── Messages whose effect is the worker-wide capture state: refused unless
  //    they name the active recording ──

  it('regression_661_step_commit_naming_another_recording_is_refused', async () => {
    const response = await send({ type: 'STEP_COMMIT', ...shown, narration: 'third' });
    assert.deepEqual(response, { ok: false, error: NOT_ACTIVE });
    assert.equal(activeStepIds(other.project_id, other.recording_id).length, 2);
    assert.equal(activeStepIds(shown.project_id, shown.recording_id).length, 2);
    assert.equal(workerStorage.pendingActions.length, 1, 'the captured action stays');
  });

  it('regression_661_recording_start_naming_another_recording_is_refused', async () => {
    await send({ type: 'RECORDING_STOP', ...other });
    const response = await send({ type: 'RECORDING_START', ...shown });
    assert.deepEqual(response, { ok: false, error: NOT_ACTIVE });
    assert.equal(workerStorage.recording, false);
  });

  it('regression_661_recording_stop_naming_another_recording_is_refused', async () => {
    const response = await send({ type: 'RECORDING_STOP', ...shown });
    assert.deepEqual(response, { ok: false, error: NOT_ACTIVE });
    assert.equal(workerStorage.recording, true);
  });

  it('regression_661_recording_stop_from_a_panel_with_no_recording_open_is_refused', async () => {
    // The breadcrumbs stop capture from the project view too, where the panel
    // shows a project and no recording.
    const response = await send({
      type: 'RECORDING_STOP',
      project_id: shown.project_id,
      recording_id: null,
    });
    assert.deepEqual(response, { ok: false, error: NOT_ACTIVE });
    assert.equal(workerStorage.recording, true);
  });

  it('regression_661_recording_clear_naming_another_recording_is_refused', async () => {
    const response = await send({ type: 'RECORDING_CLEAR', ...shown });
    assert.deepEqual(response, { ok: false, error: NOT_ACTIVE });
    assert.equal(workerStorage.pendingActions.length, 1);
  });

  it('regression_661_recording_stop_while_capture_is_off_is_answered_ok_and_changes_nothing', async () => {
    // Capture stopped in the panel that has the active recording.
    assert.equal((await send({ type: 'RECORDING_STOP', ...other })).ok, true);
    const before = JSON.stringify(workerStorage);
    // A stop from the other panel then has no running capture to protect.
    for (const recording_id of [shown.recording_id, null]) {
      const response = await send({
        type: 'RECORDING_STOP',
        project_id: shown.project_id,
        recording_id,
      });
      assert.deepEqual(response, { ok: true });
    }
    assert.equal(JSON.stringify(workerStorage), before, 'nothing changed');
  });

  // ── Capture is on only while there is an active recording ──

  it('regression_661_project_create_in_another_panel_stops_capture_as_project_open_does', async () => {
    const { project } = await send({ type: 'PROJECT_CREATE', name: 'Created elsewhere' });
    assert.equal(workerStorage.activeProjectId, project.project_id);
    assert.equal(workerStorage.activeRecordingId, null);
    assert.equal(workerStorage.recording, false, 'no recording for capture to go to');
    // As after PROJECT_OPEN, the uncommitted action is left where it was.
    assert.equal(workerStorage.pendingActions.length, 1);
    // The panel that was capturing can still stop.
    const response = await send({ type: 'RECORDING_STOP', ...other });
    assert.deepEqual(response, { ok: true });
    assert.equal(workerStorage.recording, false);
  });

  it('regression_661_projects_set_without_the_capturing_recording_stops_capture', async () => {
    const all = structuredClone(workerStorage.projects);
    // A set that keeps the capturing recording leaves capture running.
    assert.equal((await send({ type: 'PROJECTS_SET', projects: all })).ok, true);
    assert.equal(workerStorage.recording, true);
    // A set without it (a resolution that accepted its deletion) stops capture.
    const without = all.map((p) =>
      p.project_id === other.project_id ? { ...p, recordings: [] } : p,
    );
    assert.equal((await send({ type: 'PROJECTS_SET', projects: without })).ok, true);
    assert.equal(workerStorage.recording, false);
  });

  it('deleting the capturing recording or its project from another panel stops capture', async () => {
    assert.equal((await send({ type: 'RECORDING_DELETE', ...other })).ok, true);
    assert.equal(workerStorage.recording, false);
    assert.equal(workerStorage.activeRecordingId, null);
    await send({ type: 'RECORDING_OPEN', ...shown });
    await send({ type: 'RECORDING_START', ...shown });
    assert.equal(workerStorage.recording, true);
    assert.equal((await send({ type: 'PROJECT_DELETE', project_id: shown.project_id })).ok, true);
    assert.equal(workerStorage.recording, false);
    assert.equal(workerStorage.activeProjectId, null);
  });

  // ── The same messages naming the active recording act as before ──

  it('a step commit naming the active recording commits the captured action into it', async () => {
    const response = await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });
    assert.equal(response.ok, true);
    assert.equal(activeStepIds(other.project_id, other.recording_id).length, 3);
    assert.equal(workerStorage.pendingActions.length, 0);
  });

  it('a stop, start and clear naming the active recording act on capture', async () => {
    assert.equal((await send({ type: 'RECORDING_STOP', ...other })).ok, true);
    assert.equal(workerStorage.recording, false);
    assert.equal((await send({ type: 'RECORDING_START', ...other })).ok, true);
    assert.equal(workerStorage.recording, true);
    assert.equal((await send({ type: 'RECORDING_CLEAR', ...other })).ok, true);
    assert.equal(workerStorage.pendingActions.length, 0);
  });

  // ── The end of typing the worker asks the frames for ──
  //
  // A step commit and a stop ask every registered frame to end its typing and
  // wait for the answers, up to a bound; a pointer press reported by one frame
  // asks the tab's other frames, with no wait.

  describe('the end of typing', () => {
    const fromFrame = (tabId, frameId) => ({ id: 'test-extension', tab: { id: tabId }, frameId });
    const register = (tabId, frameId) =>
      workerOnMessage({ type: 'FRAME_READY' }, fromFrame(tabId, frameId), () => {});
    let asked;

    beforeEach(() => {
      asked = [];
      register(7, 0);
      register(7, 3);
      register(9, 0);
      globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
        asked.push([tabId, options.frameId, message.type]);
        return { ok: true };
      };
    });

    afterEach(() => {
      delete globalThis.chrome.tabs.sendMessage;
    });

    it('a step commit asks every registered frame once and holds what a frame wrote', async () => {
      globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
        asked.push([tabId, options.frameId, message.type]);
        // The frame in focus writes its entry before it answers.
        if (tabId === 7 && options.frameId === 3) {
          workerStorage.pendingActions.push({ type: 'type', value: 'keep' });
        }
        return { ok: true };
      };

      const response = await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });

      assert.deepEqual(asked.sort(), [
        [7, 0, 'END_TYPING'],
        [7, 3, 'END_TYPING'],
        [9, 0, 'END_TYPING'],
      ]);
      assert.deepEqual(
        response.step.actions.map((a) => a.type),
        ['click', 'type'],
      );
    });

    it('a step commit does not wait past the bound for a frame that never answers', async () => {
      globalThis.chrome.tabs.sendMessage = () => new Promise(() => {});
      const started = Date.now();

      const response = await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });

      const waited = Date.now() - started;
      assert.equal(response.ok, true);
      assert.ok(waited >= END_TYPING_BOUND - 20, `answered after ${waited} ms`);
      assert.ok(waited < END_TYPING_BOUND + 1000, `answered after ${waited} ms`);
    });

    it('a step commit goes on when a frame has no recorder to answer', async () => {
      globalThis.chrome.tabs.sendMessage = async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      };

      const response = await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });

      assert.equal(response.ok, true);
    });

    it('a stop asks every registered frame before capture goes off', async () => {
      let capturingWhenAsked = null;
      globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
        asked.push([tabId, options.frameId, message.type]);
        capturingWhenAsked = workerStorage.recording;
        return { ok: true };
      };

      assert.equal((await send({ type: 'RECORDING_STOP', ...other })).ok, true);

      assert.equal(asked.length, 3);
      assert.equal(capturingWhenAsked, true);
      assert.equal(workerStorage.recording, false);
    });

    it('a stop with capture already off asks no frame', async () => {
      await send({ type: 'RECORDING_STOP', ...other });
      register(7, 0);
      asked = [];

      await send({ type: 'RECORDING_STOP', ...other });

      assert.deepEqual(asked, []);
    });

    it('a commit with capture off asks no frame', async () => {
      await send({ type: 'RECORDING_STOP', ...other });
      register(7, 0);
      asked = [];

      await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });

      assert.deepEqual(asked, []);
    });

    it("a pointer press a frame reports asks that tab's other frames, and not the frame itself", async () => {
      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 0), () => {});
      await tick();

      assert.deepEqual(asked, [[7, 3, 'END_TYPING']]);
    });

    it('a pointer press reported by a frame that is not registered asks no frame', async () => {
      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 5), () => {});
      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(8, 0), () => {});
      workerOnMessage(
        { type: 'POINTER_PRESSED' },
        { ...fromFrame(7, 0), id: 'another-extension' },
        () => {},
      );
      await tick();

      assert.deepEqual(asked, []);
    });

    // The press's own frame writes its click at the release, which can come
    // sooner than the other frame's entry does: the worker holds what the
    // pressing frame sends behind the answers of the frames it asked.
    it('what the pressing frame writes next is stored behind what the press made another frame write', async () => {
      const append = (frame, action) =>
        new Promise((resolve) =>
          workerOnMessage({ type: 'APPEND_ACTION', action }, frame, resolve),
        );
      globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
        await tick();
        await append(fromFrame(tabId, options.frameId), { type: 'type', value: 'keep' });
        return { ok: true };
      };
      workerStorage.pendingActions = [];

      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 0), () => {});
      await append(fromFrame(7, 0), { type: 'click' });

      assert.deepEqual(
        workerStorage.pendingActions.map((a) => a.type),
        ['type', 'click'],
      );
    });

    it('what the pressing frame writes next waits no longer than the bound for a frame that never answers', async () => {
      globalThis.chrome.tabs.sendMessage = () => new Promise(() => {});
      workerStorage.pendingActions = [];
      const started = Date.now();

      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 0), () => {});
      await new Promise((resolve) =>
        workerOnMessage(
          { type: 'APPEND_ACTION', action: { type: 'click' } },
          fromFrame(7, 0),
          resolve,
        ),
      );

      const waited = Date.now() - started;
      assert.deepEqual(
        workerStorage.pendingActions.map((a) => a.type),
        ['click'],
      );
      assert.ok(waited >= END_TYPING_BOUND - 20, `stored after ${waited} ms`);
      assert.ok(waited < END_TYPING_BOUND + 1000, `stored after ${waited} ms`);
    });

    // The sender is tested as its message arrives, not when the hold ends: a
    // click that closes its own tab was sent by a registered frame.
    it('what the pressing frame wrote is stored although its tab closed while it was held', async () => {
      let answer;
      globalThis.chrome.tabs.sendMessage = () => new Promise((resolve) => (answer = resolve));
      workerStorage.pendingActions = [];

      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 0), () => {});
      const stored = new Promise((resolve) =>
        workerOnMessage(
          { type: 'APPEND_ACTION', action: { type: 'click' } },
          fromFrame(7, 0),
          resolve,
        ),
      );
      await tick();
      workerOnTabRemoved(7, { isWindowClosing: true });
      answer({ ok: true });
      await stored;

      assert.deepEqual(
        workerStorage.pendingActions.map((a) => a.type),
        ['click'],
      );
    });

    it('a press in a tab with no other frame holds nothing back', async () => {
      workerStorage.pendingActions = [];
      const started = Date.now();

      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(9, 0), () => {});
      await new Promise((resolve) =>
        workerOnMessage(
          { type: 'APPEND_ACTION', action: { type: 'click' } },
          fromFrame(9, 0),
          resolve,
        ),
      );

      assert.equal(workerStorage.pendingActions.length, 1);
      assert.ok(Date.now() - started < END_TYPING_BOUND / 2);
    });

    // A worker that was suspended comes back with an empty registry; typing
    // sends it nothing, so the press or the commit can be the first it hears.
    describe('with a tab whose registration is gone', () => {
      let framesOf;
      let queryTabs;

      beforeEach(() => {
        framesOf = globalThis.chrome.webNavigation.getAllFrames;
        queryTabs = globalThis.chrome.tabs.query;
        globalThis.chrome.webNavigation.getAllFrames = async ({ tabId }) =>
          tabId === 11 ? [{ frameId: 0 }, { frameId: 4 }] : [];
        globalThis.chrome.tabs.query = async () => [{ id: 7 }, { id: 11 }];
      });

      afterEach(() => {
        globalThis.chrome.webNavigation.getAllFrames = framesOf;
        globalThis.chrome.tabs.query = queryTabs;
      });

      it("a pointer press from the tab asks the tab's other frames", async () => {
        workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(11, 0), () => {});
        await tick();

        assert.deepEqual(asked, [[11, 4, 'END_TYPING']]);
      });

      it('a step commit asks the frames of the tab too', async () => {
        await send({ type: 'STEP_COMMIT', ...other, narration: 'third' });

        assert.deepEqual(asked.sort(), [
          [11, 0, 'END_TYPING'],
          [11, 4, 'END_TYPING'],
          [7, 0, 'END_TYPING'],
          [7, 3, 'END_TYPING'],
          [9, 0, 'END_TYPING'],
        ]);
      });

      // The message that wakes a suspended worker is read before the worker
      // has read the stored recording flag back.
      it('a press that wakes the worker is held to the stored recording flag', async () => {
        const live = workerOnMessage;
        const get = globalThis.chrome.storage.local.get;
        globalThis.chrome.storage.local.get = async (keys) => {
          await tick();
          return get(keys);
        };
        try {
          // A second instance of the worker module: one that starts as a
          // suspended worker does, with nothing in memory.
          const worker = new URL('../../background/service-worker.js', import.meta.url);
          worker.search = 'woken';
          await import(worker.href);
          workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(11, 0), () => {});
          await tick();
          await tick();
          await tick();

          assert.deepEqual(asked, [[11, 4, 'END_TYPING']]);
        } finally {
          workerOnMessage = live;
          globalThis.chrome.storage.local.get = get;
        }
      });

      it('a stop asks the frames of the tab too', async () => {
        await send({ type: 'RECORDING_STOP', ...other });

        assert.equal(asked.filter(([tabId]) => tabId === 11).length, 2);
      });
    });

    it('a pointer press reported with capture off asks no frame', async () => {
      await send({ type: 'RECORDING_STOP', ...other });
      register(7, 0);
      register(7, 3);
      asked = [];

      workerOnMessage({ type: 'POINTER_PRESSED' }, fromFrame(7, 0), () => {});
      await tick();

      assert.deepEqual(asked, []);
    });
  });
});
