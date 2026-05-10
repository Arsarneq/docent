/**
 * dispatch-core.js — Platform-agnostic dispatch logic
 *
 * Contains URL validation, payload construction, HTTP dispatch, and error types.
 * Platform-specific concerns (settings persistence, asset loading) live in each
 * platform package.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * Validates an endpoint URL string.
 * @param {string} url
 * @returns {string|null} null if valid, error string if invalid
 */
export function validateEndpointUrl(url) {
  if (url === '') return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return null;
  return 'Endpoint URL must start with http:// or https://';
}

/**
 * Builds the dispatch payload from a project and selected recordings.
 * @param {object} project
 * @param {object[]} recordings — full recordings with steps array
 * @param {string} readingGuidance — human-readable prose explaining the payload
 * @param {object} schema — the JSON Schema object for this platform
 * @returns {object} DispatchPayload
 */
export function buildPayload(project, recordings, readingGuidance, schema) {
  return {
    reading_guidance: readingGuidance,
    schema,
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
    },
    recordings: recordings.map(r => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: (r.steps ?? []).map(step => ({
        uuid: step.uuid,
        logical_id: step.logical_id,
        step_number: step.step_number,
        created_at: step.created_at,
        ...(step.narration && { narration: step.narration }),
        ...(step.narration_source && { narration_source: step.narration_source }),
        ...(step.step_type && { step_type: step.step_type }),
        ...(step.expect && { expect: step.expect }),
        actions: step.actions,
        deleted: step.deleted,
      })),
    })),
  };
}

/**
 * Error thrown by sendPayload for network failures or non-2xx responses.
 */
export class DispatchError extends Error {
  /**
   * @param {string} message
   * @param {number|null} status — HTTP status code, or null for network errors
   */
  constructor(message, status) {
    super(message);
    this.name = 'DispatchError';
    this.status = status;
  }
}

/**
 * Sends the payload to the endpoint via HTTP POST.
 * @param {string} endpointUrl
 * @param {string|null} apiKey
 * @param {object} payload
 * @returns {Promise<object>} parsed JSON response, or empty object if not JSON
 * @throws {DispatchError}
 */
export async function sendPayload(endpointUrl, apiKey, payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetch(endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new DispatchError(`Network error: ${err.message}`, null);
  }

  if (!response.ok) {
    throw new DispatchError(`Request failed with status ${response.status}`, response.status);
  }

  try {
    return await response.json();
  } catch {
    return {};
  }
}
