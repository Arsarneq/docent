/**
 * control-commands.js — Maps a control-channel command to a side panel action.
 *
 * A command that reaches this module has already passed the channel's pairing
 * and validation (control-channel.js). Each one is carried out through the
 * panel action a person's click runs, so the panel's own view and state follow
 * it, and the answer carries identifiers and counts only — never the captured
 * actions, the project model or any setting.
 *
 * The panel is injected as a small set of functions, so the unit suite drives
 * this module as shipped.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * @typedef {object} ControlPanel
 * @property {() => {project: object|null, recording: object|null,
 *   capturing: boolean, pendingCount: number, stepCount: number,
 *   rerecording: boolean, busy: boolean}} getState - the panel's current view
 *   state; `busy` while a step commit is under way
 * @property {(name: string) => Promise<object>} createProject - the New project
 *   action; resolves with the created project
 * @property {(name: string) => Promise<object>} createRecording - the New
 *   recording action, which also starts capture; resolves with the recording
 * @property {(on: boolean) => Promise<void>} setCapture - the Pause / Resume action
 * @property {(payload: object) => Promise<object>} commitStep - the Done this
 *   step action; resolves with the worker's response
 */

const NO_PROJECT = { ok: false, error: 'No open project' };
const NO_RECORDING = { ok: false, error: 'No open recording' };
const RERECORDING = { ok: false, error: 'The panel is re-recording a step' };
const COMMITTING = { ok: false, error: 'The panel is committing a step' };
const NO_ACTIONS = { ok: false, error: 'No captured actions' };
const NOT_COMMITTED = { ok: false, error: 'The step was not committed' };

const projectIdAndName = (project) => ({ project_id: project.project_id, name: project.name });
const recordingIdAndName = (recording) => ({
  recording_id: recording.recording_id,
  name: recording.name,
});

async function setCapture(panel, on) {
  const state = panel.getState();
  if (!state.recording) return NO_RECORDING;
  if (state.capturing !== on) await panel.setCapture(on);
  return { ok: true, capturing: on };
}

// One handler per command of the channel's closed set. A Map, so a command
// name is looked up among these entries alone.
const HANDLERS = new Map([
  [
    'status',
    async (panel) => {
      const state = panel.getState();
      return {
        ok: true,
        project: state.project ? projectIdAndName(state.project) : null,
        recording: state.recording ? recordingIdAndName(state.recording) : null,
        capturing: state.capturing,
        pending_actions: state.pendingCount,
        steps: state.stepCount,
      };
    },
  ],
  [
    'project.create',
    async (panel, args) => ({
      ok: true,
      project: projectIdAndName(await panel.createProject(args.name)),
    }),
  ],
  [
    'recording.create',
    async (panel, args) => {
      if (!panel.getState().project) return NO_PROJECT;
      return { ok: true, recording: recordingIdAndName(await panel.createRecording(args.name)) };
    },
  ],
  ['recording.pause', (panel) => setCapture(panel, false)],
  ['recording.resume', (panel) => setCapture(panel, true)],
  [
    'step.commit',
    async (panel, args) => {
      const state = panel.getState();
      if (!state.recording) return NO_RECORDING;
      // The panel's own commit button is disabled until something is captured.
      if (state.pendingCount === 0) return NO_ACTIONS;
      // A narration sent over the channel was not typed into the panel, so the
      // step states no narration source rather than the panel's "typed".
      const response = await panel.commitStep({ ...args });
      if (!response?.ok) return NOT_COMMITTED;
      return {
        ok: true,
        step: {
          logical_id: response.step.logical_id,
          step_number: response.step.step_number,
          actions: response.step.actions.length,
        },
        steps: response.activeSteps.length,
      };
    },
  ],
]);

/**
 * Create the executor the control channel hands validated commands to.
 *
 * @param {ControlPanel} panel
 * @returns {(command: {id: string, name: string, args: object}) => Promise<object>}
 *   resolves with `{ ok: true, … }` or `{ ok: false, error }`
 */
export function createControlExecutor(panel) {
  return async function execute(command) {
    const handler = HANDLERS.get(command.name);
    if (!handler) return { ok: false, error: 'Unknown command' };
    // A re-record or a commit under way is a person's action in progress; only
    // the read goes through.
    if (command.name !== 'status') {
      const state = panel.getState();
      if (state.rerecording) return RERECORDING;
      if (state.busy) return COMMITTING;
    }
    return handler(panel, command.args);
  };
}
