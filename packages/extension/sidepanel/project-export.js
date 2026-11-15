/**
 * project-export.js — The side panel's Export action, split into its build and
 * its delivery.
 *
 * The build asks the service worker for the project open in this panel, by its
 * id — never the worker-wide active project, which another open panel can move
 * — and stamps it into the `.docent.json` export through the shared
 * buildExport. The Export button delivers the document as a download and the
 * control channel's export delivers it in a result (control-channel LC-8); both
 * run this one build. Plain data in and out, with the worker message and the
 * schema load injected, so the unit suite exercises the function the panel
 * runs (the pure-logic discipline lib/frame-trust.js names).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { buildExport } from '../shared/lib/export-project.js';

/** The answer when no project is open, to the Export button and to a channel command alike. */
export const NO_OPEN_PROJECT = 'No open project';

/**
 * Build the export of the project open in the panel.
 *
 * @param {object} params
 * @param {{project_id: string}|null} params.project - the panel's open project
 * @param {(message: object) => Promise<object>} params.send - sends a message
 *   to the service worker and resolves with its response
 * @param {() => Promise<object>} params.loadSchema - the composed schema, the
 *   source of the export's format stamp
 * @returns {Promise<{ok: true, project: object, document: object} |
 *   {ok: false, error: string}>} `project` is the stored project the worker
 *   returned, `document` the stamped export; a failure is answered in-band and
 *   opens no dialog
 */
export async function buildOpenProjectExport({ project, send, loadSchema }) {
  if (!project) return { ok: false, error: NO_OPEN_PROJECT };
  const response = await send({ type: 'PROJECT_EXPORT', project_id: project.project_id });
  if (!response?.ok) return { ok: false, error: response?.error ?? 'unknown error' };
  try {
    // Stamped here in the panel, where the composed schema is available (the
    // service worker doesn't load it); the schema is the stamp's one source.
    const document = buildExport(response.project, await loadSchema());
    return { ok: true, project: response.project, document };
  } catch {
    return { ok: false, error: 'The export could not be stamped' };
  }
}

/**
 * The file name the Export button downloads a project's export under.
 *
 * @param {{name: string}} project - the exported project
 * @param {number} time - the moment of the export, in milliseconds
 * @returns {string}
 */
export function exportFileName(project, time) {
  return `${project.name.replace(/\s+/g, '_')}_${time}.docent.json`;
}
