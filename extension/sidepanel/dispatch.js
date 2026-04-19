/**
 * dispatch.js — Dispatch Service Module
 *
 * Handles endpoint settings persistence, payload construction, and HTTP dispatch
 * for the Docent Chrome Extension's integrated dispatch feature.
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
 * Loads dispatch settings from chrome.storage.local.
 * @returns {Promise<{endpointUrl: string|null, apiKey: string|null}>}
 */
export async function loadDispatchSettings() {
  try {
    const result = await chrome.storage.local.get(['docentEndpointUrl', 'docentApiKey']);
    return {
      endpointUrl: result.docentEndpointUrl ?? null,
      apiKey: result.docentApiKey ?? null,
    };
  } catch {
    return { endpointUrl: null, apiKey: null };
  }
}

/**
 * Saves dispatch settings to chrome.storage.local.
 * Throws if endpointUrl is non-empty and invalid.
 * Removes keys from storage when values are empty.
 * @param {string} endpointUrl
 * @param {string} apiKey
 */
export async function saveDispatchSettings(endpointUrl, apiKey) {
  const urlError = validateEndpointUrl(endpointUrl);
  if (endpointUrl !== '' && urlError !== null) {
    throw new Error(urlError);
  }

  if (endpointUrl === '') {
    await chrome.storage.local.remove('docentEndpointUrl');
  } else {
    await chrome.storage.local.set({ docentEndpointUrl: endpointUrl });
  }

  if (apiKey === '') {
    await chrome.storage.local.remove('docentApiKey');
  } else {
    await chrome.storage.local.set({ docentApiKey: apiKey });
  }
}

/**
 * Loads the bundled reading guidance markdown text.
 * Returns empty string and logs a warning on failure.
 * @returns {Promise<string>}
 */
export async function loadReadingGuidance() {
  try {
    const url = chrome.runtime.getURL('assets/reading-guidance.md');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    console.warn('[Docent] Failed to load reading guidance:', err);
    return '';
  }
}

/**
 * Builds the dispatch payload from a project and selected recordings.
 * @param {object} project
 * @param {object[]} recordings — already-resolved recordings (each has activeSteps array)
 * @param {string} readingGuidance
 * @returns {object} DispatchPayload
 */
export function buildPayload(project, recordings, readingGuidance) {
  return {
    reading_guidance: readingGuidance,
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
    },
    recordings: recordings.map(r => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      steps: (r.activeSteps ?? []).map(step => ({
        logical_id: step.logical_id,
        step_number: step.step_number,
        narration: step.narration,
        actions: step.actions,
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
