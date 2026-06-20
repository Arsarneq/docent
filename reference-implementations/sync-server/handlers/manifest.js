/**
 * manifest.js — the `GET /projects` handler for the Reference Sync Server
 * (Requirement 1, Project Manifest Endpoint).
 *
 * The manifest is the JSON array returned by `GET /projects`, where each entry
 * is `{ project_id, name, last_modified }` (the Project_Manifest). This handler
 * is deliberately thin: it asks the injected Storage_Provider for the manifest
 * and serializes it. The entries come STRAIGHT from `storage.list()` — the
 * handler does not reshape them beyond what `list()` returns (Requirement 1.2).
 *
 * The provider derives each entry's `project_id` and `name` from the stored
 * payload's `project` object and `last_modified` from the server-maintained
 * timestamp (Requirement 1.4); neither the provider nor this handler reads or
 * interprets the `docent_format` stamp or any step internals — the server stays
 * opaque. An empty store yields an empty array (Requirement 1.3), which falls
 * out naturally because `storage.list()` returns `[]` when nothing is stored.
 *
 * Handler convention (shared by every protocol handler): an async function
 * `(storage, req, res)` that writes the HTTP response directly via
 * `res.writeHead` / `res.end`. The router (Task 8.1) dispatches to it after auth
 * and wraps the invocation in a top-level try/catch that maps any unhandled
 * error to HTTP 500 (Requirement 5.6), so this handler does not catch its own
 * errors.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module handlers/manifest
 */

/**
 * Handle `GET /projects`: respond with HTTP 200 and a JSON array of
 * Project_Manifest entries, one per stored project (Requirements 1.1, 1.2). An
 * empty store responds with `200 []` (Requirement 1.3). The response
 * `Content-Type` is `application/json`.
 *
 * @param {import('../storage/provider.js').StorageProvider} storage
 *   The injected Storage_Provider (Requirement 7.1: handlers reach stored
 *   projects only through this seam).
 * @param {import('node:http').IncomingMessage} _req
 *   The incoming request. Unused: the manifest takes no input.
 * @param {import('node:http').ServerResponse} res
 *   The response to write.
 * @returns {Promise<void>}
 */
export async function handleManifest(storage, _req, res) {
  // The manifest comes straight from the storage seam; no reshaping (R1.2).
  // An empty store returns [], satisfying R1.3 without a special case.
  const manifest = await storage.list();

  const body = JSON.stringify(manifest);
  // `no-store` so a browser-based client never serves a stale manifest from its
  // HTTP cache (see read-project.js for the full rationale).
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
