/**
 * dispatch.js — Dispatch Service Module (Chrome Extension)
 *
 * Re-exports platform-agnostic dispatch logic from shared.
 *
 * Platform-specific settings persistence and asset loading have been
 * moved to adapter-chrome.js as part of the platform adapter pattern.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

export { validateEndpointUrl, buildPayload, sendPayload, DispatchError } from '../shared/dispatch-core.js';
