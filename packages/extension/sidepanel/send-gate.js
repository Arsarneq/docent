/**
 * send-gate.js — Pure send-eligibility logic for the side panel.
 *
 * Decides whether the panel's Send button is enabled, which recordings the
 * dispatch flow offers, and the values the confirmation view shows. Plain data
 * in and out, no DOM and no chrome.* calls: the panel imports it and writes the
 * results to the page, and the unit suite imports the same functions, so the
 * cases exercise the code the panel runs. Active steps are resolved by the
 * shared resolver (session-format SF-8); what eligibility means is the dispatch
 * protocol's (dispatch DI-13).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */
// Governance declared in scripts/area-map.json (see its declared-governance entry): send eligibility over a project's recordings, resolved through the shared active-steps resolver.

import { resolveActiveSteps } from '../shared/lib/session.js';

/**
 * A recording's active steps through the shared resolver; a recording with no
 * steps array resolves to an empty active view rather than throwing. Part of
 * the module's interface: the other exports resolve through it, and a caller
 * needing one recording's active view calls it directly.
 *
 * @param {{ steps?: Array<object> }} recording
 * @returns {Array<object>} the active steps, in step_number order
 */
export function resolveRecordingActiveSteps(recording) {
  return resolveActiveSteps(recording.steps ? recording : { steps: [] });
}

/**
 * Whether the Send button is enabled: an endpoint is configured and at least
 * one recording of the project has an active step.
 *
 * @param {{ endpointUrl?: string|null }} dispatchSettings
 * @param {{ recordings?: Array<object> }|null|undefined} project
 * @returns {boolean}
 */
export function shouldDispatchButtonBeEnabled(dispatchSettings, project) {
  if (!dispatchSettings.endpointUrl) return false;
  const recordings = project?.recordings ?? [];
  return recordings.some((r) => resolveRecordingActiveSteps(r).length > 0);
}

/**
 * The recordings the dispatch flow offers: those with at least one active step,
 * each annotated with its `activeSteps`.
 *
 * @param {{ recordings?: Array<object> }|null|undefined} project
 * @returns {Array<object>} the recordings, each with an `activeSteps` array
 */
export function getRecordingsWithActiveSteps(project) {
  return (project?.recordings ?? [])
    .map((r) => ({ ...r, activeSteps: resolveRecordingActiveSteps(r) }))
    .filter((r) => r.activeSteps.length > 0);
}

/**
 * The total active-step count over annotated recordings.
 *
 * @param {Array<{ activeSteps: Array<object> }>} recordings — from getRecordingsWithActiveSteps
 * @returns {number}
 */
export function countActiveSteps(recordings) {
  return recordings.reduce((n, r) => n + r.activeSteps.length, 0);
}

/**
 * The values the confirmation view shows for a selection of annotated
 * recordings: the endpoint, the recording names, and the step count as text,
 * with the count as a number for the dispatch selection.
 *
 * @param {{ endpointUrl?: string|null }} dispatchSettings
 * @param {Array<{ name: string, activeSteps: Array<object> }>} recordings — from getRecordingsWithActiveSteps
 * @returns {{ endpoint: string, recordings: string, steps: string, totalSteps: number }}
 */
export function buildConfirmationValues(dispatchSettings, recordings) {
  const totalSteps = countActiveSteps(recordings);
  return {
    endpoint: dispatchSettings.endpointUrl ?? '',
    recordings: recordings.map((r) => r.name).join(', '),
    steps: String(totalSteps),
    totalSteps,
  };
}
