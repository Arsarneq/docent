/**
 * control-commands.js — Maps a control-channel command to a side panel action.
 *
 * A command that reaches this module has already passed the channel's pairing
 * and validation (control-channel.js). Each one is carried out through the
 * panel action a person's click runs, so the panel's own view and state follow
 * it, and the answer carries identifiers, names, counts, flags and notice
 * codes — never the captured actions, the project model or any setting, save
 * the export of the open project when the person allowed it at turn-on
 * (control-channel LC-9). The panel's storage banner renders from the same
 * storage codes (STORAGE_NOTICES), so a code and the banner that shows its
 * state cannot drift apart.
 *
 * The panel is injected as a small set of functions, so the unit suite drives
 * this module as shipped.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { NO_OPEN_PROJECT } from './project-export.js';

/**
 * @typedef {object} ControlPanel
 * @property {() => {project: object|null, recording: object|null,
 *   capturing: boolean, pendingCount: number, stepCount: number,
 *   rerecording: boolean, busy: boolean, storageQuota: object|null}} getState -
 *   the panel's current view state; `busy` while a step commit is under way;
 *   `storageQuota` the storage-pressure state the panel last received
 * @property {(name: string) => Promise<{ok: boolean, project?: object}>}
 *   createProject - the New project action; resolves with the service
 *   worker's response, which carries the created project
 * @property {(name: string) => Promise<{ok: boolean, recording?: object}>}
 *   createRecording - the New recording action, which also starts capture;
 *   resolves with the service worker's response, which carries the recording
 *   and answers `Project not found` for a project deleted in another panel
 * @property {(on: boolean) => Promise<{ok: boolean}>} setCapture - the Pause /
 *   Resume action; resolves with the service worker's response, which refuses
 *   a resume once another panel has opened or created a project or recording,
 *   and a pause while that other panel's capture runs
 * @property {(payload: object) => Promise<object>} commitStep - the Done this
 *   step action; resolves with the worker's response
 * @property {() => Promise<{ok: boolean, project?: object, document?: object,
 *   error?: string}>} exportProject - the build the Export button runs for the
 *   open project (project-export.js), without its download or its dialog
 */

const NO_PROJECT = { ok: false, error: NO_OPEN_PROJECT };
const NO_RECORDING = { ok: false, error: 'No open recording' };
const RERECORDING = { ok: false, error: 'The panel is re-recording a step' };
const COMMITTING = { ok: false, error: 'The panel is committing a step' };
const NO_ACTIONS = { ok: false, error: 'No captured actions' };
const NOT_COMMITTED = { ok: false, error: 'The step was not committed' };
const EXPORT_NOT_ALLOWED = {
  ok: false,
  error: 'Export was not allowed when local control was turned on',
};
const NOT_EXPORTED = { ok: false, error: 'The project was not exported' };
const NOT_PAUSED = { ok: false, error: 'The recording was not paused' };
const NOT_RESUMED = { ok: false, error: 'The recording was not resumed' };
const PROJECT_NOT_CREATED = { ok: false, error: 'The project was not created' };
const RECORDING_NOT_CREATED = { ok: false, error: 'The recording was not created' };

/**
 * The notice codes of the three storage pressure states, which the panel's
 * storage banner shows on every view and renders from.
 */
export const STORAGE_NOTICES = Object.freeze({
  full: 'storage_full_capture_stopped',
  paused: 'storage_almost_full_capture_paused',
  stillRecording: 'storage_almost_full_still_recording',
});
const RERECORDING_STEP = 'rerecording_step';

/**
 * The closed set of notice codes `status` reports, in the fixed order a
 * result lists them (control-channel LC-9). Each stands for a panel state: the
 * three storage pressure states, then a re-record under way.
 */
export const NOTICES = Object.freeze([
  STORAGE_NOTICES.full,
  STORAGE_NOTICES.paused,
  STORAGE_NOTICES.stillRecording,
  RERECORDING_STEP,
]);

/**
 * The notice code for a storage pressure state, or `null` when the state is
 * none of the three. A pure function of the state the service worker
 * publishes (extension capture ECP-11): the `exceeded` band is full, the
 * `warn` band is almost full, paused or still recording, and any other band
 * is no pressure state.
 *
 * @param {{band?: string, paused?: boolean}|null|undefined} quota
 * @returns {string|null}
 */
export function storageNotice(quota) {
  if (quota?.band === 'exceeded') return STORAGE_NOTICES.full;
  if (quota?.band === 'warn')
    return quota.paused === true ? STORAGE_NOTICES.paused : STORAGE_NOTICES.stillRecording;
  return null;
}

/**
 * The notices that hold in a panel state, as a new list in NOTICES order. The
 * re-record notice reads the state that refuses every command but `status`
 * (control-channel LC-8), and carries none of the step's narration.
 */
function noticesOf(state) {
  const held = new Set([storageNotice(state.storageQuota)]);
  if (state.rerecording === true) held.add(RERECORDING_STEP);
  return NOTICES.filter((code) => held.has(code));
}

const projectIdAndName = (project) => ({ project_id: project.project_id, name: project.name });
const recordingIdAndName = (recording) => ({
  recording_id: recording.recording_id,
  name: recording.name,
});

async function setCapture(panel, on) {
  const state = panel.getState();
  if (!state.recording) return NO_RECORDING;
  if (state.capturing !== on) {
    const response = await panel.setCapture(on);
    if (!response?.ok) return on ? NOT_RESUMED : NOT_PAUSED;
  }
  return { ok: true, capturing: on };
}

// One handler per command of the channel's closed set. A Map, so a command
// name is looked up among these entries alone.
const HANDLERS = new Map([
  [
    'status',
    async (panel, _args, channel) => {
      const state = panel.getState();
      return {
        ok: true,
        project: state.project ? projectIdAndName(state.project) : null,
        recording: state.recording ? recordingIdAndName(state.recording) : null,
        capturing: state.capturing,
        pending_actions: state.pendingCount,
        steps: state.stepCount,
        export_allowed: channel.exportAllowed === true,
        notices: noticesOf(state),
      };
    },
  ],
  [
    'project.create',
    async (panel, args) => {
      const response = await panel.createProject(args.name);
      if (!response?.ok) return PROJECT_NOT_CREATED;
      return { ok: true, project: projectIdAndName(response.project) };
    },
  ],
  [
    'recording.create',
    async (panel, args) => {
      if (!panel.getState().project) return NO_PROJECT;
      const response = await panel.createRecording(args.name);
      if (!response?.ok) return RECORDING_NOT_CREATED;
      return { ok: true, recording: recordingIdAndName(response.recording) };
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
  [
    'project.export',
    async (panel, _args, channel) => {
      if (channel.exportAllowed !== true) return EXPORT_NOT_ALLOWED;
      if (!panel.getState().project) return NO_PROJECT;
      // The document goes back in the result; the Export button's download and
      // its alert() on failure stay with the click.
      let built;
      try {
        built = await panel.exportProject();
      } catch {
        return NOT_EXPORTED;
      }
      if (!built?.ok) return NOT_EXPORTED;
      return { ok: true, project: projectIdAndName(built.project), export: built.document };
    },
  ],
]);

/**
 * Create the executor the control channel hands validated commands to.
 *
 * @param {ControlPanel} panel
 * @returns {(command: {id: string, name: string, args: object},
 *   channel?: {exportAllowed?: boolean}) => Promise<object>} resolves with
 *   `{ ok: true, … }` or `{ ok: false, error }`; `channel.exportAllowed` is
 *   the person's export grant, and only `true` grants it
 */
export function createControlExecutor(panel) {
  return async function execute(command, channel = {}) {
    const handler = HANDLERS.get(command.name);
    if (!handler) return { ok: false, error: 'Unknown command' };
    // A re-record or a commit under way is a person's action in progress; only
    // the read goes through.
    if (command.name !== 'status') {
      const state = panel.getState();
      if (state.rerecording) return RERECORDING;
      if (state.busy) return COMMITTING;
    }
    return handler(panel, command.args, channel);
  };
}
