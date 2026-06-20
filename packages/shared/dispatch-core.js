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

import { stampFromSchema } from './lib/format-stamp.js';
import { httpRequest } from './lib/http-transport.js';

/**
 * Validates an endpoint URL string.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.hasApiKey=false] — whether an API key is configured for
 *   this endpoint. When true, a plaintext `http://` endpoint is rejected unless
 *   it targets loopback, because the `Authorization: Bearer` header (and the
 *   session payload, which may contain PII) would travel unencrypted and be
 *   readable by an on-path attacker.
 * @returns {string|null} null if valid, error string if invalid
 */
export function validateEndpointUrl(url, { hasApiKey = false } = {}) {
  if (url === '') return null;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'Endpoint URL must start with http:// or https://';
  }
  // Validate URL is well-formed
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Endpoint URL is not a valid URL';
  }
  // Reject embedded credentials (security risk)
  if (parsed.username || parsed.password) {
    return 'Endpoint URL must not contain embedded credentials';
  }
  // Reject empty hostname
  if (!parsed.hostname) {
    return 'Endpoint URL must have a hostname';
  }

  const host = normalizeHostname(parsed.hostname);

  // Always reject the link-local / cloud-metadata range (169.254.0.0/16,
  // including the 169.254.169.254 metadata endpoint) — never a legitimate
  // dispatch/sync target, and a classic SSRF pivot.
  if (isLinkLocalIpv4(host)) {
    return 'Endpoint URL must not target a link-local address (169.254.0.0/16)';
  }

  // An API key over plaintext http:// exposes the key and payload in transit.
  // Permit http:// only for loopback (local dev); require https:// otherwise.
  if (hasApiKey && parsed.protocol === 'http:' && !isLoopbackHost(host)) {
    return 'Use https:// when an API key is set (http:// is allowed only for localhost)';
  }

  return null;
}

/** Lower-cases and strips IPv6 brackets from a URL hostname. */
function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/** True for loopback hosts: localhost, 127.0.0.0/8, and ::1. */
function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  // 127.0.0.0/8
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && Number(m[1]) === 127;
}

/** True for IPv4 link-local 169.254.0.0/16 (cloud metadata endpoint range). */
function isLinkLocalIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && Number(m[1]) === 169 && Number(m[2]) === 254;
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
    docent_format: stampFromSchema(schema),
    project: {
      project_id: project.project_id,
      name: project.name,
      created_at: project.created_at,
      ...(project.metadata && { metadata: project.metadata }),
    },
    recordings: recordings.map((r) => ({
      recording_id: r.recording_id,
      name: r.name,
      created_at: r.created_at,
      ...(r.metadata && { metadata: r.metadata }),
      steps: (r.steps ?? []).map((step) => ({
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
 *
 * Transient failures (network error, HTTP 429, or 5xx) are retried with
 * exponential backoff + jitter, up to `maxRetries` attempts. A `Retry-After`
 * header on a 429/503 response is honoured when present. Non-transient failures
 * (4xx other than 429) throw immediately.
 *
 * @param {string} endpointUrl
 * @param {string|null} apiKey
 * @param {object} payload
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] — max retry attempts after the first try
 * @param {(ms:number)=>Promise<void>} [opts.sleep] — injectable delay (for tests)
 * @returns {Promise<object>} parsed JSON response, or empty object if not JSON
 * @throws {DispatchError}
 */
export async function sendPayload(endpointUrl, apiKey, payload, opts = {}) {
  const { maxRetries = 3, sleep = defaultSleep } = opts;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Serialize payload and check outbound size (once — independent of retries).
  const body = JSON.stringify(payload);
  if (body.length > 50 * 1024 * 1024) {
    throw new DispatchError(
      'Payload too large (>50MB). Consider sending recordings individually.',
      null,
    );
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter: base 500ms, doubling, capped 8s.
      // Honour Retry-After (seconds) from the previous response when present.
      const backoff = Math.min(500 * 2 ** (attempt - 1), 8000);
      const delay = lastError?.retryAfterMs ?? Math.floor(Math.random() * backoff);
      await sleep(delay);
    }

    // Per-attempt timeout: abort after 30 seconds.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await httpRequest(endpointUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      // Network error / timeout — transient, retry.
      lastError =
        err.name === 'AbortError'
          ? new DispatchError('Request timed out after 30 seconds', null)
          : new DispatchError(`Network error: ${err.message}`, null);
      continue;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      const err = new DispatchError(
        `Request failed with status ${response.status}`,
        response.status,
      );
      if (transient && attempt < maxRetries) {
        err.retryAfterMs = parseRetryAfter(response);
        lastError = err;
        continue;
      }
      throw err;
    }

    // Response size guard: reject responses larger than 10MB.
    const contentLength = response.headers?.get?.('content-length');
    if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
      throw new DispatchError('Response too large (>10MB)', null);
    }

    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  // Retries exhausted on a transient failure.
  throw lastError ?? new DispatchError('Request failed after retries', null);
}

/** Default delay used between retries. Overridable in tests. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header (delta-seconds form) into milliseconds, capped
 * at 30s. Returns null when absent or unparseable (caller falls back to jitter).
 */
function parseRetryAfter(response) {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = parseInt(raw, 10);
  if (Number.isNaN(secs) || secs < 0) return null;
  return Math.min(secs, 30) * 1000;
}
