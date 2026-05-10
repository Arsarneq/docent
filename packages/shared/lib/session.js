/**
 * Docent — Session model
 *
 * Data hierarchy:
 *   Project → Recording → Step (versioned records)
 *
 * Versioning rules (scoped to Recording):
 *   - Each Step record has a uuid (v7, time-ordered) and a logical_id
 *   - Multiple records sharing a logical_id are versions of the same step
 *   - Latest uuid per logical_id = active version
 *   - Records with deleted: true are tombstones
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { uuidv7 } from './uuid-v7.js';

// ─── Project ──────────────────────────────────────────────────────────────────

/**
 * Creates a new empty project.
 * @param {string} name
 * @returns {Project}
 */
export function createProject(name = 'Untitled Project') {
  return {
    project_id: uuidv7(),
    name,
    created_at: new Date().toISOString(),
    recordings: [],
  };
}

// ─── Recording ────────────────────────────────────────────────────────────────

/**
 * Creates a new empty recording and appends it to the project.
 * @param {Project} project
 * @param {string} name
 * @returns {Recording}
 */
export function createRecording(project, name = 'Untitled Recording') {
  const recording = {
    recording_id: uuidv7(),
    name,
    created_at:   new Date().toISOString(),
    steps:        [],
  };
  project.recordings.push(recording);
  return recording;
}

/**
 * Finds a recording within a project by id.
 * @param {Project} project
 * @param {string} recording_id
 * @returns {Recording|undefined}
 */
export function findRecording(project, recording_id) {
  return project.recordings.find(r => r.recording_id === recording_id);
}

// ─── Steps ────────────────────────────────────────────────────────────────────

/**
 * Creates a new step record.
 * Pass logical_id when replacing an existing step; omit for brand new steps.
 *
 * @param {object} params
 * @param {string}           [params.narration]
 * @param {string}           [params.narration_source]
 * @param {string}           [params.step_type]
 * @param {string}           [params.expect]
 * @param {number}           params.step_number
 * @param {Action[]}         params.actions
 * @param {string}           [params.logical_id]
 * @returns {Step}
 */
export function createStep({ narration, narration_source, step_type, expect, step_number, actions, logical_id }) {
  const step = {
    uuid:             uuidv7(),
    logical_id:       logical_id ?? uuidv7(),
    step_number,
    created_at:       new Date().toISOString(),
    actions,
    deleted:          false,
  };
  // Include narration fields when present (narration mode)
  if (narration != null) {
    step.narration = narration;
    step.narration_source = narration_source;
  }
  // Include simple mode fields when present
  if (step_type != null) {
    step.step_type = step_type;
  }
  if (expect != null) {
    step.expect = expect;
  }
  return step;
}

/**
 * Resolves the active (current, non-deleted) steps from a recording,
 * sorted by step_number ascending.
 * @param {Recording} recording
 * @returns {Step[]}
 */
export function resolveActiveSteps(recording) {
  const groups = new Map();

  for (const step of recording.steps) {
    const existing = groups.get(step.logical_id);
    if (!existing || step.uuid > existing.uuid) {
      groups.set(step.logical_id, step);
    }
  }

  return Array.from(groups.values())
    .filter(step => !step.deleted)
    .sort((a, b) => a.step_number - b.step_number);
}

/**
 * Returns all historical versions for a given logical_id, newest first.
 * @param {Recording} recording
 * @param {string} logical_id
 * @returns {Step[]}
 */
export function getStepHistory(recording, logical_id) {
  return recording.steps
    .filter(s => s.logical_id === logical_id)
    .sort((a, b) => (a.uuid > b.uuid ? -1 : 1));
}

/**
 * Adds a step record to a recording.
 * @param {Recording} recording
 * @param {Step} step
 */
export function addStepRecord(recording, step) {
  recording.steps.push(step);
}

/**
 * Soft-deletes the active version of a step by creating a tombstone record.
 * @param {Recording} recording
 * @param {string} logical_id
 */
export function deleteStep(recording, logical_id) {
  const active = resolveActiveSteps(recording).find(s => s.logical_id === logical_id);
  if (!active) return;

  recording.steps.push({
    ...active,
    uuid:       uuidv7(),
    created_at: new Date().toISOString(),
    deleted:    true,
  });
}

/**
 * Reorders steps by reassigning step_number values.
 * Creates new version records only for steps whose number changed.
 * @param {Recording} recording
 * @param {string[]} orderedLogicalIds
 */
export function reorderSteps(recording, orderedLogicalIds) {
  const active = resolveActiveSteps(recording);
  const byId   = new Map(active.map(s => [s.logical_id, s]));

  orderedLogicalIds.forEach((logical_id, index) => {
    const step      = byId.get(logical_id);
    const newNumber = index + 1;
    if (!step || step.step_number === newNumber) return;

    recording.steps.push({
      ...step,
      uuid:        uuidv7(),
      step_number: newNumber,
      created_at:  new Date().toISOString(),
    });
  });
}
