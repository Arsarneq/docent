/**
 * connection-test.js — Connection_Test + settings fingerprint for Auto-Sync.
 *
 * Auto-Sync (Requirement 23) is a client-local mode that can be enabled only
 * after a Connection_Test confirms the configured server settings can reach the
 * Sync_Server. This module is the small, pure shared helper the settings state
 * machine in each platform panel consumes; the panels own the enable rule and
 * the Sync_Trigger lifecycle, while the WHEN/WHETHER-to-test logic and the
 * fingerprint that detects a settings change live here so both platforms behave
 * identically (Requirements 16.5, 17.3, 23.2, 23.3, 23.17).
 *
 * Two exports:
 *
 *   - `testConnection(serverUrl, apiKey)` — issues a single `GET /projects`
 *     against the existing read endpoint and classifies the outcome as
 *     `pass` / `auth` / `unreachable`. It adds no test-specific server support:
 *     a normal successful response is `pass`, a 401/403 is an `auth` failure,
 *     and a network error or any other non-success status is `unreachable`
 *     (Requirements 16.5, 23.2).
 *
 *   - `settingsFingerprint(serverUrl, apiKey)` — a stable, deterministic
 *     fingerprint of the server settings a test was taken against, so a later
 *     change to the endpoint or API key no longer matches the stored
 *     `testedSettingsFingerprint` and forces Auto-Sync off until a fresh test
 *     passes (Requirement 23.3).
 *
 * Design decisions:
 *
 *   - **Existing endpoint only (R16.5).** The Connection_Test reuses the same
 *     `GET /projects` manifest read the pull path uses (see `pullProjects` in
 *     sync-client.js) and the same Bearer-token header builder, so it requires
 *     no Sync_Server change and no test-specific endpoint.
 *
 *   - **Non-empty endpoint assumed (R23.17).** The panel enable rule verifies an
 *     endpoint is present BEFORE invoking the Connection_Test, so this helper
 *     does not re-validate an empty/absent `serverUrl` — it composes the request
 *     URL directly, exactly as the pull path does.
 *
 *   - **Plaintext key in the fingerprint (R23.3).** The fingerprint is computed
 *     over the endpoint and the PLAINTEXT API key the client holds in memory —
 *     never the at-rest encrypted envelope — so re-encrypting or re-deriving the
 *     stored secret across restarts does not spuriously invalidate a still-valid
 *     test.
 *
 *   - **The fingerprint IS the canonical projection string.** Like sync-digest's
 *     content digest, the fingerprint is the canonical JSON of the
 *     settings projection rather than a fixed-size hash: equality of
 *     fingerprints is exactly equality of (endpoint, plaintext key), with zero
 *     collision risk, and it needs no synchronous strong-hash primitive (which
 *     is unavailable in the Tauri webview). It is a local, opaque marker — never
 *     transmitted to the Sync_Server (Requirement 23.1, 23.3).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { buildHeaders } from './sync-client.js';
import { canonicalize } from './sync-digest.js';
import { httpRequest } from './lib/http-transport.js';

/**
 * Issue a single `GET /projects` against the configured server and classify the
 * outcome for the Auto-Sync settings state machine (Requirements 16.5, 23.2).
 *
 * Classification:
 *   - a successful response (HTTP 2xx) → `{ ok: true, reason: 'pass' }`;
 *   - HTTP 401 or 403 → `{ ok: false, reason: 'auth' }` (bad/absent credentials);
 *   - a thrown fetch (network failure) or any other non-success status (e.g.
 *     404/500) → `{ ok: false, reason: 'unreachable' }`.
 *
 * Assumes a non-empty `serverUrl`: the panel enable rule checks an endpoint is
 * present before calling this, so the Connection_Test is never invoked with an
 * empty or absent endpoint (Requirement 23.17). The request reuses the existing
 * read endpoint and Bearer-token header, adding no test-specific server support
 * (Requirement 16.5).
 *
 * @param {string} serverUrl - base URL of the sync server (non-empty, R23.17)
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @returns {Promise<{ ok: boolean, reason: ('pass'|'auth'|'unreachable') }>}
 */
export async function testConnection(serverUrl, apiKey) {
  const headers = buildHeaders(apiKey);

  let response;
  try {
    response = await httpRequest(`${serverUrl}/projects`, {
      method: 'GET',
      headers,
      // Bypass the HTTP cache so a connection test reflects the live server, not
      // a cached response from the webview `fetch` (extension). See sync-client.
      cache: 'no-store',
    });
  } catch {
    // Network failure (DNS, refused, offline, CORS, …) — the server could not
    // be reached at all. Not an auth distinction; report unreachable (R23.2).
    return { ok: false, reason: 'unreachable' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'auth' };
  }

  if (response.ok) {
    return { ok: true, reason: 'pass' };
  }

  // Reachable but the request did not succeed (e.g. 404/500). Treat as
  // unreachable for the purpose of enabling Auto-Sync — the settings are not
  // confirmed working, and this is not an auth-credential problem (R23.2).
  return { ok: false, reason: 'unreachable' };
}

/**
 * Compute a stable, deterministic fingerprint of the server settings a
 * Connection_Test was taken against, so a later change to the endpoint or API
 * key invalidates a prior passing test (Requirement 23.3).
 *
 * Computed over the endpoint and the PLAINTEXT `apiKey` held in memory — never
 * the at-rest encrypted envelope — so re-encrypting or re-deriving the stored
 * secret across restarts does not change the fingerprint and therefore does not
 * spuriously invalidate a still-valid test (Requirement 23.3). The result is the
 * canonical JSON of the `{ serverUrl, apiKey }` projection: two settings that
 * differ in either field yield different fingerprints, identical settings yield
 * byte-identical fingerprints, and there is no collision risk (the fingerprint
 * IS the canonical projection).
 *
 * A missing key (`undefined`) is normalized to `null` so "no key" has a single,
 * stable representation regardless of how the caller spells it.
 *
 * @param {string} serverUrl - the configured endpoint
 * @param {string|null} [apiKey] - the plaintext API key, or null/undefined when none
 * @returns {string} an opaque, client-local fingerprint string (never sent to the server)
 */
export function settingsFingerprint(serverUrl, apiKey) {
  return canonicalize({
    serverUrl,
    apiKey: apiKey === undefined ? null : apiKey,
  });
}
