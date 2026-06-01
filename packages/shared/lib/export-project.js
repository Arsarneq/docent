/**
 * export-project.js — Builds the `.docent.json` export object for a project.
 *
 * The export is the project + full recording history, stamped with the
 * self-describing `docent_format` header (see lib/format-stamp.js). Unlike the
 * dispatch payload, it carries no `reading_guidance` or `schema` wrapper — just
 * the stamp, project, and recordings. Both platforms build their export through
 * this single function so the shape and the stamp stay identical everywhere.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { stampFromSchema } from './format-stamp.js';

/**
 * Build the stamped `.docent.json` export object for a project.
 *
 * @param {object} project - the full project (with recordings + step history)
 * @param {object} schema - the composed platform schema (source of the stamp)
 * @returns {object} the export object: { docent_format, project, recordings }
 */
export function buildExport(project, schema) {
  return {
    docent_format: stampFromSchema(schema),
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
    },
    recordings: (project.recordings ?? []).map((r) => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: r.steps ?? [],
    })),
  };
}
