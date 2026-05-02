/**
 * dispatch.js — Dispatch Service Module (Chrome Extension)
 *
 * Re-exports platform-agnostic dispatch logic from shared, and adds
 * Chrome-specific settings persistence and asset loading.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { validateEndpointUrl as _validateEndpointUrl } from '../shared/dispatch-core.js';

export { validateEndpointUrl, buildPayload, sendPayload, DispatchError } from '../shared/dispatch-core.js';

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
  const urlError = _validateEndpointUrl(endpointUrl);
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
    const url = chrome.runtime.getURL('shared/assets/reading-guidance.md');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (err) {
    console.warn('[Docent] Failed to load reading guidance:', err);
    return '';
  }
}
