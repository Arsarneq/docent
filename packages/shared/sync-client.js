/**
 * sync-client.js — Platform-agnostic remote sync logic
 *
 * Contains push/pull operations, payload construction, and error types
 * for bidirectional HTTP synchronization of Docent projects with a remote server.
 * Uses fetch API only — no DOM, no platform APIs.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { isValidUuidv7 } from './lib/uuid-v7.js';
import { stampFromSchema } from './lib/format-stamp.js';
import { validatePayload } from './lib/validate-import.js';

/**
 * Error thrown by sync operations for HTTP or network failures.
 */
export class SyncError extends Error {
  /**
   * @param {string} message
   * @param {number|null} status — HTTP status code, or null for network errors
   * @param {string|null} projectName — which project failed, or null for manifest
   */
  constructor(message, status, projectName) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.projectName = projectName;
  }
}

/**
 * @typedef {Object} SyncResult
 * @property {string[]} pushed - project_ids successfully pushed
 * @property {string[]} pulled - project_ids successfully pulled
 * @property {SyncError[]} errors - errors encountered (non-fatal per-project)
 * @property {boolean} halted - true if sync was halted (auth failure)
 */

/**
 * Builds request headers for sync operations.
 * Includes Bearer token when apiKey is non-null.
 * @param {string|null} apiKey
 * @returns {object}
 */
export function buildHeaders(apiKey) {
  const headers = {};
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Constructs the Full_Project_Payload shape for a project.
 * Sends full step history without filtering.
 *
 * The payload carries the self-describing `docent_format` stamp (read off the
 * composed schema, the single source of truth). Sync used to omit the stamp,
 * but with client auto-update two clients on one server can be on different
 * schema versions/platforms; the stamp lets the puller detect that. See
 * SECURITY_BACKLOG S12 and docs/sync-protocol.md.
 *
 * @param {object} project
 * @param {object} schema - the composed platform schema (source of the stamp)
 * @returns {object} { docent_format, project: {...}, recordings: [...] }
 */
export function buildPayloadForProject(project, schema) {
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

/**
 * Returns true if the status code indicates an auth failure (401 or 403).
 * @param {number|null} status
 * @returns {boolean}
 */
function isAuthError(status) {
  return status === 401 || status === 403;
}

/**
 * Push all local projects to the server.
 * Sends PUT /projects/:id for each project with Full_Project_Payload body.
 * Non-auth errors on one project do not prevent other projects from being processed.
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {object[]} projects - array of local project objects
 * @param {object} schema - composed platform schema (for the docent_format stamp)
 * @returns {Promise<{pushed: string[], errors: SyncError[], halted: boolean}>}
 */
export async function pushProjects(serverUrl, apiKey, projects, schema) {
  const pushed = [];
  const errors = [];

  for (const project of projects) {
    const payload = buildPayloadForProject(project, schema);
    const url = `${serverUrl}/projects/${encodeURIComponent(project.project_id)}`;
    const headers = {
      ...buildHeaders(apiKey),
      'Content-Type': 'application/json',
    };

    let response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const syncErr = new SyncError(
        `Network error pushing "${project.name}": ${err.message}`,
        null,
        project.name,
      );
      errors.push(syncErr);
      continue;
    }

    if (isAuthError(response.status)) {
      const syncErr = new SyncError(
        `Authentication failed (${response.status}) pushing "${project.name}"`,
        response.status,
        project.name,
      );
      errors.push(syncErr);
      return { pushed, errors, halted: true };
    }

    if (response.ok) {
      pushed.push(project.project_id);
    } else {
      const syncErr = new SyncError(
        `Push failed for "${project.name}" with status ${response.status}`,
        response.status,
        project.name,
      );
      errors.push(syncErr);
    }
  }

  return { pushed, errors, halted: false };
}

/**
 * Pull all projects from the server.
 * Fetches GET /projects for the manifest, then GET /projects/:id for each entry.
 * Non-auth errors on one project do not prevent other projects from being fetched.
 *
 * Each pulled payload is schema-validated before being accepted (S12). An
 * invalid payload is skipped and recorded as a per-project SyncError
 * (reject-but-log) — the rest of the pull continues.
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {(data: unknown) => boolean & { errors?: object[] }} validator -
 *   generated platform validator for the full `.docent.json` envelope
 * @returns {Promise<{projects: object[], errors: SyncError[], halted: boolean}>}
 */
export async function pullProjects(serverUrl, apiKey, validator) {
  const projects = [];
  const errors = [];
  const headers = buildHeaders(apiKey);

  // Fetch manifest
  let manifestResponse;
  try {
    manifestResponse = await fetch(`${serverUrl}/projects`, {
      method: 'GET',
      headers,
    });
  } catch (err) {
    const syncErr = new SyncError(
      `Network error fetching project manifest: ${err.message}`,
      null,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, halted: false };
  }

  if (isAuthError(manifestResponse.status)) {
    const syncErr = new SyncError(
      `Authentication failed (${manifestResponse.status}) fetching project manifest`,
      manifestResponse.status,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, halted: true };
  }

  if (!manifestResponse.ok) {
    const syncErr = new SyncError(
      `Failed to fetch project manifest with status ${manifestResponse.status}`,
      manifestResponse.status,
      null,
    );
    errors.push(syncErr);
    return { projects, errors, halted: false };
  }

  const manifest = await manifestResponse.json();

  // Fetch each project by id
  for (const entry of manifest) {
    // The manifest comes from the server (untrusted). Validate the id shape
    // before interpolating it into the request path — a malformed or hostile
    // id must not be able to reshape the authenticated request URL (the Bearer
    // token rides along). See SECURITY_BACKLOG S15.
    if (!entry || typeof entry !== 'object' || !isValidUuidv7(entry.project_id)) {
      errors.push(
        new SyncError(`Skipped manifest entry with invalid project_id`, null, entry?.name ?? null),
      );
      continue;
    }
    const url = `${serverUrl}/projects/${encodeURIComponent(entry.project_id)}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
      });
    } catch (err) {
      const syncErr = new SyncError(
        `Network error fetching project "${entry.name}": ${err.message}`,
        null,
        entry.name,
      );
      errors.push(syncErr);
      continue;
    }

    if (isAuthError(response.status)) {
      const syncErr = new SyncError(
        `Authentication failed (${response.status}) fetching project "${entry.name}"`,
        response.status,
        entry.name,
      );
      errors.push(syncErr);
      return { projects, errors, halted: true };
    }

    if (!response.ok) {
      const syncErr = new SyncError(
        `Failed to fetch project "${entry.name}" with status ${response.status}`,
        response.status,
        entry.name,
      );
      errors.push(syncErr);
      continue;
    }

    const payload = await response.json();

    // Validate the pulled payload against the platform schema before accepting
    // it (S12). A malformed or version/platform-mismatched payload is skipped
    // and reported (reject-but-log); the rest of the pull continues.
    const { valid, errors: validationErrors } = validatePayload(validator, payload);
    if (!valid) {
      errors.push(
        new SyncError(
          `Pulled project "${entry.name}" failed schema validation: ${validationErrors.join('; ')}`,
          null,
          entry.name,
        ),
      );
      continue;
    }

    // Reconstruct project from Full_Project_Payload shape using an explicit
    // field allowlist — never spread untrusted JSON into stored state.
    const project = {
      project_id: payload.project.project_id,
      name: payload.project.name,
      created_at: payload.project.created_at,
      ...(payload.project.metadata && { metadata: payload.project.metadata }),
      recordings: (payload.recordings ?? []).map((r) => ({
        recording_id: r.recording_id,
        name: r.name,
        created_at: r.created_at,
        ...(r.metadata && { metadata: r.metadata }),
        steps: r.steps ?? [],
      })),
    };
    projects.push(project);
  }

  return { projects, errors, halted: false };
}

/**
 * Execute a full sync cycle: push local projects, then pull server projects.
 * Push executes before pull (R8-AC3).
 * 401/403 on any request halts entire sync.
 *
 * @param {string} serverUrl - base URL of the sync server
 * @param {string|null} apiKey - Bearer token, or null for unauthenticated
 * @param {object[]} localProjects - array of local project objects (full shape)
 * @param {object} schema - composed platform schema (for the docent_format stamp on push)
 * @param {(data: unknown) => boolean & { errors?: object[] }} validator -
 *   generated platform validator applied to each pulled payload
 * @returns {Promise<{result: SyncResult, projects: object[]}>}
 */
export async function sync(serverUrl, apiKey, localProjects, schema, validator) {
  const allErrors = [];

  // 1. Push phase
  const pushResult = await pushProjects(serverUrl, apiKey, localProjects, schema);
  allErrors.push(...pushResult.errors);

  if (pushResult.halted) {
    return {
      result: {
        pushed: pushResult.pushed,
        pulled: [],
        errors: allErrors,
        halted: true,
      },
      projects: localProjects,
    };
  }

  // 2. Pull phase
  const pullResult = await pullProjects(serverUrl, apiKey, validator);
  allErrors.push(...pullResult.errors);

  if (pullResult.halted) {
    return {
      result: {
        pushed: pushResult.pushed,
        pulled: [],
        errors: allErrors,
        halted: true,
      },
      projects: localProjects,
    };
  }

  // 3. Merge pulled projects into local list
  // Server-wins: same project_id = replace; new project_id = append
  const mergedProjects = [...localProjects];

  for (const pulledProject of pullResult.projects) {
    const localIndex = mergedProjects.findIndex((p) => p.project_id === pulledProject.project_id);
    if (localIndex >= 0) {
      mergedProjects[localIndex] = pulledProject;
    } else {
      mergedProjects.push(pulledProject);
    }
  }

  const pulled = pullResult.projects.map((p) => p.project_id);

  return {
    result: {
      pushed: pushResult.pushed,
      pulled,
      errors: allErrors,
      halted: false,
    },
    projects: mergedProjects,
  };
}
