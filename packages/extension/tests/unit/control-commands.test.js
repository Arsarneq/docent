/**
 * control-commands.test.js — Unit tests for the mapping from a control-channel
 * command to the side panel action that carries it out.
 *
 * The executor is driven with a fake panel, so each case states which panel
 * action a command becomes, what the command is told back, and when the panel's
 * own state refuses it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createControlExecutor } from '../../sidepanel/control-commands.js';
import { CONTROL_COMMANDS } from '../../sidepanel/control-channel.js';
import { buildOpenProjectExport } from '../../sidepanel/project-export.js';
import { buildExport } from '../../shared/lib/export-project.js';

/** A composed schema as far as the export stamp reads it. */
const SCHEMA = {
  $defs: {
    docent_format: {
      properties: { platform: { const: 'extension' }, schema_version: { const: '9.9.9' } },
    },
  },
};

/**
 * A worker holding two stored projects, the second of them its worker-wide
 * active project, answering PROJECT_EXPORT the way the service worker does: by
 * the project id the message names.
 */
function fakeWorker() {
  const projects = [
    {
      project_id: 'p1',
      name: 'P',
      created_at: 1,
      recordings: [
        {
          recording_id: 'r1',
          name: 'R',
          created_at: 2,
          steps: [{ logical_id: 'l1', step_number: 1, actions: [{ type: 'click', value: 's' }] }],
        },
      ],
    },
    { project_id: 'p2', name: 'Other', created_at: 3, recordings: [] },
  ];
  const messages = [];
  return {
    projects,
    messages,
    async send(message) {
      messages.push(message);
      const project = projects.find((p) => p.project_id === message.project_id);
      return project ? { ok: true, project } : { ok: false, error: 'Project not found' };
    },
  };
}

function fakePanel(initial = {}, worker = fakeWorker()) {
  const calls = [];
  const state = {
    project: null,
    recording: null,
    capturing: false,
    pendingCount: 0,
    stepCount: 0,
    rerecording: false,
    busy: false,
    ...initial,
  };
  const panel = {
    calls,
    state,
    getState: () => ({ ...state }),
    async createProject(name) {
      calls.push(['createProject', name]);
      state.project = { project_id: 'p1', name, recordings: [{ secret: true }] };
      state.recording = null;
      state.capturing = false;
      return state.project;
    },
    async createRecording(name) {
      calls.push(['createRecording', name]);
      state.recording = { recording_id: 'r1', name, steps: [{ secret: true }] };
      state.capturing = true;
      return state.recording;
    },
    async setCapture(on) {
      calls.push(['setCapture', on]);
      state.capturing = on;
    },
    async commitStep(payload) {
      calls.push(['commitStep', payload]);
      if (state.pendingCount === 0)
        return { ok: false, error: 'No actions recorded for this step' };
      const step = {
        logical_id: 'l1',
        step_number: state.stepCount + 1,
        narration: payload.narration,
        actions: Array.from({ length: state.pendingCount }, () => ({ type: 'click', value: 's' })),
      };
      state.stepCount += 1;
      state.pendingCount = 0;
      return { ok: true, step, activeSteps: [step] };
    },
    // The panel's Export action, as shipped, over the panel's open project.
    async exportProject() {
      calls.push(['exportProject']);
      return buildOpenProjectExport({
        project: state.project,
        send: (message) => worker.send(message),
        loadSchema: async () => SCHEMA,
      });
    },
  };
  return panel;
}

const run = (panel, name, args = {}, channel) =>
  createControlExecutor(panel)({ id: '1', name, args }, channel);

const GRANTED = { exportAllowed: true };

const OPEN = {
  project: { project_id: 'p1', name: 'P' },
  recording: { recording_id: 'r1', name: 'R' },
};

describe('createControlExecutor — status', () => {
  it('reports an idle panel', async () => {
    assert.deepEqual(await run(fakePanel(), 'status'), {
      ok: true,
      project: null,
      recording: null,
      capturing: false,
      pending_actions: 0,
      steps: 0,
      export_allowed: false,
    });
  });

  it('reports whether the person allowed export at turn-on', async () => {
    assert.equal((await run(fakePanel(), 'status', {}, GRANTED)).export_allowed, true);
    assert.equal(
      (await run(fakePanel(), 'status', {}, { exportAllowed: false })).export_allowed,
      false,
    );
    assert.equal(
      (await run(fakePanel(), 'status', {}, { exportAllowed: 'yes' })).export_allowed,
      false,
    );
  });

  it('reports the open project and recording by id and name only', async () => {
    const panel = fakePanel({
      project: { project_id: 'p1', name: 'P', recordings: [{ steps: ['x'] }] },
      recording: { recording_id: 'r1', name: 'R', steps: ['x'] },
      capturing: true,
      pendingCount: 3,
      stepCount: 2,
    });
    assert.deepEqual(await run(panel, 'status'), {
      ok: true,
      project: { project_id: 'p1', name: 'P' },
      recording: { recording_id: 'r1', name: 'R' },
      capturing: true,
      pending_actions: 3,
      steps: 2,
      export_allowed: false,
    });
    assert.deepEqual(panel.calls, []);
  });
});

describe('createControlExecutor — project and recording', () => {
  it('creates a project through the panel and answers its id and name only', async () => {
    const panel = fakePanel();
    assert.deepEqual(await run(panel, 'project.create', { name: 'Checkout' }), {
      ok: true,
      project: { project_id: 'p1', name: 'Checkout' },
    });
    assert.deepEqual(panel.calls, [['createProject', 'Checkout']]);
  });

  it('creates a recording in the open project', async () => {
    const panel = fakePanel({ project: OPEN.project });
    assert.deepEqual(await run(panel, 'recording.create', { name: 'Happy path' }), {
      ok: true,
      recording: { recording_id: 'r1', name: 'Happy path' },
    });
    assert.deepEqual(panel.calls, [['createRecording', 'Happy path']]);
  });

  it('refuses a recording when no project is open', async () => {
    const panel = fakePanel();
    assert.deepEqual(await run(panel, 'recording.create', { name: 'R' }), {
      ok: false,
      error: 'No open project',
    });
    assert.deepEqual(panel.calls, []);
  });
});

describe('createControlExecutor — pause and resume', () => {
  it('pauses a capturing recording', async () => {
    const panel = fakePanel({ ...OPEN, capturing: true });
    assert.deepEqual(await run(panel, 'recording.pause'), { ok: true, capturing: false });
    assert.deepEqual(panel.calls, [['setCapture', false]]);
  });

  it('resumes a paused recording', async () => {
    const panel = fakePanel({ ...OPEN, capturing: false });
    assert.deepEqual(await run(panel, 'recording.resume'), { ok: true, capturing: true });
    assert.deepEqual(panel.calls, [['setCapture', true]]);
  });

  it('answers a pause of a paused recording without touching the panel', async () => {
    const panel = fakePanel({ ...OPEN, capturing: false });
    assert.deepEqual(await run(panel, 'recording.pause'), { ok: true, capturing: false });
    assert.deepEqual(panel.calls, []);
  });

  it('answers a resume of a capturing recording without touching the panel', async () => {
    const panel = fakePanel({ ...OPEN, capturing: true });
    assert.deepEqual(await run(panel, 'recording.resume'), { ok: true, capturing: true });
    assert.deepEqual(panel.calls, []);
  });

  for (const name of ['recording.pause', 'recording.resume']) {
    it(`refuses ${name} when no recording is open`, async () => {
      const panel = fakePanel({ project: OPEN.project });
      assert.deepEqual(await run(panel, name), { ok: false, error: 'No open recording' });
      assert.deepEqual(panel.calls, []);
    });
  }
});

describe('createControlExecutor — step commit', () => {
  it('commits with narration and claims no narration source', async () => {
    const panel = fakePanel({ ...OPEN, capturing: true, pendingCount: 2 });
    assert.deepEqual(await run(panel, 'step.commit', { narration: 'Open the cart' }), {
      ok: true,
      step: { logical_id: 'l1', step_number: 1, actions: 2 },
      steps: 1,
    });
    // The panel's own commit states `narration_source: "typed"`; a narration a
    // local process sent was not typed, so the channel's commit states none.
    assert.deepEqual(panel.calls, [['commitStep', { narration: 'Open the cart' }]]);
  });

  it('commits a classified step', async () => {
    const panel = fakePanel({ ...OPEN, pendingCount: 1 });
    await run(panel, 'step.commit', { step_type: 'validation', expect: 'absent' });
    assert.deepEqual(panel.calls, [['commitStep', { step_type: 'validation', expect: 'absent' }]]);
  });

  it('answers counts, never the captured actions themselves', async () => {
    const panel = fakePanel({ ...OPEN, pendingCount: 2 });
    const result = await run(panel, 'step.commit', { narration: 'n' });
    assert.equal(JSON.stringify(result).includes('"value"'), false);
    assert.equal('activeSteps' in result, false);
  });

  it('refuses a commit with no captured actions without touching the panel', async () => {
    const panel = fakePanel({ ...OPEN, pendingCount: 0 });
    assert.deepEqual(await run(panel, 'step.commit', { narration: 'n' }), {
      ok: false,
      error: 'No captured actions',
    });
    assert.deepEqual(panel.calls, []);
  });

  it('answers a commit the panel could not make with a fixed text', async () => {
    const panel = fakePanel({ ...OPEN, pendingCount: 2 });
    panel.commitStep = async () => ({ ok: false, error: 'storage detail /a/b' });
    assert.deepEqual(await run(panel, 'step.commit', { narration: 'n' }), {
      ok: false,
      error: 'The step was not committed',
    });
  });

  it('refuses when no recording is open', async () => {
    const panel = fakePanel({ project: OPEN.project, pendingCount: 2 });
    assert.deepEqual(await run(panel, 'step.commit', { narration: 'n' }), {
      ok: false,
      error: 'No open recording',
    });
    assert.deepEqual(panel.calls, []);
  });
});

describe('createControlExecutor — project export', () => {
  it('refuses an export the person did not allow at turn-on, touching nothing', async () => {
    for (const channel of [undefined, {}, { exportAllowed: false }, { exportAllowed: 'yes' }]) {
      const worker = fakeWorker();
      const panel = fakePanel(OPEN, worker);
      assert.deepEqual(await run(panel, 'project.export', {}, channel), {
        ok: false,
        error: 'Export was not allowed when local control was turned on',
      });
      assert.deepEqual(panel.calls, []);
      assert.deepEqual(worker.messages, []);
    }
  });

  it('refuses an export when no project is open, touching nothing', async () => {
    const worker = fakeWorker();
    const panel = fakePanel({}, worker);
    assert.deepEqual(await run(panel, 'project.export', {}, GRANTED), {
      ok: false,
      error: 'No open project',
    });
    assert.deepEqual(panel.calls, []);
    assert.deepEqual(worker.messages, []);
  });

  it('exports the project open in this panel, as its Export button builds it', async () => {
    // The worker's active project is another one; the panel has p1 open.
    const worker = fakeWorker();
    const panel = fakePanel({ project: { project_id: 'p1', name: 'P' } }, worker);
    const result = await run(panel, 'project.export', {}, GRANTED);
    assert.deepEqual(result, {
      ok: true,
      project: { project_id: 'p1', name: 'P' },
      export: buildExport(worker.projects[0], SCHEMA),
    });
    assert.deepEqual(worker.messages, [{ type: 'PROJECT_EXPORT', project_id: 'p1' }]);
  });

  it('carries the full step history of the open project', async () => {
    const worker = fakeWorker();
    const panel = fakePanel({ project: { project_id: 'p1', name: 'P' } }, worker);
    const result = await run(panel, 'project.export', {}, GRANTED);
    assert.deepEqual(result.export.recordings[0].steps, worker.projects[0].recordings[0].steps);
    assert.deepEqual(result.export.docent_format, {
      platform: 'extension',
      schema_version: '9.9.9',
    });
  });

  it('answers an export the panel could not make with a fixed text, opening no dialog', async () => {
    const dialogs = [];
    const saved = { alert: globalThis.alert, confirm: globalThis.confirm };
    globalThis.alert = (text) => dialogs.push(['alert', text]);
    globalThis.confirm = (text) => {
      dialogs.push(['confirm', text]);
      return true;
    };
    try {
      for (const failing of [
        async () => ({ ok: false, error: 'storage detail /a/b' }),
        async () => undefined,
        async () => {
          throw new Error('secret /home/someone');
        },
      ]) {
        const worker = fakeWorker();
        worker.send = failing;
        const panel = fakePanel({ project: { project_id: 'p1', name: 'P' } }, worker);
        assert.deepEqual(await run(panel, 'project.export', {}, GRANTED), {
          ok: false,
          error: 'The project was not exported',
        });
      }
      // An open project the worker no longer holds.
      const panel = fakePanel({ project: { project_id: 'gone', name: 'Gone' } });
      assert.deepEqual(await run(panel, 'project.export', {}, GRANTED), {
        ok: false,
        error: 'The project was not exported',
      });
    } finally {
      globalThis.alert = saved.alert;
      globalThis.confirm = saved.confirm;
    }
    assert.deepEqual(dialogs, []);
  });
});

describe('createControlExecutor — bounds', () => {
  it('refuses every changing command while the panel is re-recording a step', async () => {
    for (const [name, args] of [
      ['project.create', { name: 'P' }],
      ['recording.create', { name: 'R' }],
      ['recording.pause', {}],
      ['recording.resume', {}],
      ['step.commit', { narration: 'n' }],
      ['project.export', {}],
    ]) {
      const panel = fakePanel({ ...OPEN, capturing: true, pendingCount: 1, rerecording: true });
      const result = await run(panel, name, args, GRANTED);
      assert.equal(result.ok, false, name);
      assert.match(result.error, /re-record/i);
      assert.deepEqual(panel.calls, [], name);
    }
  });

  it('refuses every changing command while the panel is committing a step', async () => {
    for (const [name, args] of [
      ['project.create', { name: 'P' }],
      ['recording.create', { name: 'R' }],
      ['recording.pause', {}],
      ['recording.resume', {}],
      ['step.commit', { narration: 'n' }],
      ['project.export', {}],
    ]) {
      const panel = fakePanel({ ...OPEN, capturing: true, pendingCount: 1, busy: true });
      assert.deepEqual(await run(panel, name, args, GRANTED), {
        ok: false,
        error: 'The panel is committing a step',
      });
      assert.deepEqual(panel.calls, [], name);
    }
  });

  it('still answers status while re-recording', async () => {
    const panel = fakePanel({ ...OPEN, rerecording: true });
    assert.equal((await run(panel, 'status')).ok, true);
  });

  it('refuses a name outside the command set', async () => {
    const panel = fakePanel(OPEN);
    assert.deepEqual(await run(panel, 'project.delete'), { ok: false, error: 'Unknown command' });
    assert.deepEqual(await run(panel, 'constructor'), { ok: false, error: 'Unknown command' });
    assert.deepEqual(panel.calls, []);
  });

  it('carries out every command of the closed set', async () => {
    for (const name of CONTROL_COMMANDS) {
      const panel = fakePanel({ ...OPEN, pendingCount: 1 });
      const result = await run(panel, name, { name: 'N', narration: 'n' }, GRANTED);
      assert.notEqual(result.error, 'Unknown command', name);
      assert.equal(result.ok, true, name);
    }
  });
});
