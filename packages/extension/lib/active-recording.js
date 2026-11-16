/**
 * active-recording.js — Whether a panel message names the recording capture
 * goes to.
 *
 * Each open side panel shows a project and, in the recording view, a
 * recording, while capture is one per browser: the service worker's active
 * project and recording receive what is captured, and they follow whichever
 * panel last opened or created a project or a recording. A message whose
 * effect is that capture state names the project and recording its panel shows,
 * and the worker refuses it with the fixed text below unless they are the
 * active ones — save a stop while capture is off, which has no capture to
 * protect and is carried out whatever it names (extension runtime, Panel
 * protocol). The panel reads the same text to tell that refusal from the
 * action's other failures.
 *
 * Pure (no chrome APIs), shared by the service worker and the side panel.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** The error a refused capture message is answered with. */
export const NOT_ACTIVE_RECORDING = 'Not the active recording';

/**
 * Whether a message names the active project and recording. A missing id
 * reads as none, and none matches only none.
 *
 * @param {{project_id?: string|null, recording_id?: string|null}} message
 * @param {{projectId: string|null, recordingId: string|null}} active
 * @returns {boolean}
 */
export function namesActiveRecording(message, active) {
  return (
    (message.project_id ?? null) === active.projectId &&
    (message.recording_id ?? null) === active.recordingId
  );
}
