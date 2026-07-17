/**
 * import-project.js — Maps an imported `.docent.json` export object into a local
 * project. The single-source counterpart to lib/export-project.js: export builds
 * the on-disk shape, import reconstructs the in-memory project from it, so the two
 * stay symmetric and a re-export round-trips.
 *
 * Steps are normalized through an explicit allowlist so an imported file cannot
 * smuggle unknown keys into the store; the allowlist carries every legal step
 * field and preserves the ABSENCE of optional ones (a simple-mode step legally
 * lacks `narration_source`; a narration-mode step lacks `step_type`/`expect`).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// Governed by the format area (its doc set carries the format doc): reconstructs steps per the format's step schema; the per-platform schemas are authoritative for field semantics.

import { uuidv7 } from './uuid-v7.js';

/**
 * Normalize one imported step into the stored step shape.
 *
 * @param {object} s - a step from the imported file
 * @returns {object} the stored step
 */
export function normalizeImportedStep(s) {
  return {
    uuid: s.uuid ?? uuidv7(),
    logical_id: s.logical_id,
    step_number: s.step_number,
    created_at: s.created_at,
    // Optional step fields are carried through only when present, so a step that
    // legally lacks one keeps lacking it: a simple-mode step has no
    // `narration_source` (schema `const: "typed"`), a narration-mode step no
    // `step_type`/`expect`. Stamping a default would make a valid file re-export
    // schema-invalid (issue #293).
    ...(s.narration && { narration: s.narration }),
    ...(s.narration_source && { narration_source: s.narration_source }),
    ...(s.step_type && { step_type: s.step_type }),
    ...(s.expect && { expect: s.expect }),
    actions: s.actions ?? [],
    deleted: s.deleted ?? false,
  };
}

/**
 * Build a local project from an imported `.docent.json` export object. When a
 * project with the same `project_id` already exists in the store, the import is
 * taken as a copy — a fresh `project_id` and a `" (copy)"` name — so it never
 * overwrites; otherwise identity is preserved.
 *
 * @param {object[]} existingProjects - the projects already in the local store
 * @param {object} exportData - the parsed `.docent.json` export object
 * @returns {object} the new local project (not yet persisted)
 */
export function buildImportedProject(existingProjects, exportData) {
  const imported = exportData.project;
  const exists = existingProjects.some((p) => p.project_id === imported.project_id);

  return {
    project_id: exists ? uuidv7() : imported.project_id,
    name: exists ? `${imported.name} (copy)` : imported.name,
    created_at: imported.created_at ?? new Date().toISOString(),
    // Carry project/recording metadata the way buildExport does, so the two stay
    // symmetric and user-entered metadata survives a round-trip.
    ...(imported.metadata && { metadata: imported.metadata }),
    recordings: (exportData.recordings ?? []).map((r) => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: (r.steps ?? []).map(normalizeImportedStep),
    })),
  };
}
