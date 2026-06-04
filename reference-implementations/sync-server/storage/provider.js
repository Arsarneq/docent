/**
 * Storage_Provider contract for the Reference Sync Server.
 *
 * The server reaches stored projects ONLY through this interface, so the
 * persistence backend can be swapped without touching the request-handling
 * logic (Requirement 7.1). A provider stores, for each project, the verbatim
 * `Full_Project_Payload` plus a server-maintained `last_modified` timestamp —
 * the timestamp is metadata kept ALONGSIDE the payload and is never merged into
 * it (Requirements 3.7, 4.1, 7.6).
 *
 * @module storage/provider
 */

/**
 * A stored project record: the verbatim payload plus its server-maintained
 * `last_modified` timestamp.
 *
 * @typedef {Object} StoredProject
 * @property {object} payload       The Full_Project_Payload, stored VERBATIM
 *                                  (Requirements 3.5, 4). The server never
 *                                  validates, reshapes, or interprets it.
 * @property {string} last_modified Server write timestamp, ISO 8601
 *                                  (Requirement 3.7); NOT part of the payload.
 */

/**
 * A single entry in the Project_Manifest returned by `GET /projects`.
 *
 * @typedef {Object} ManifestEntry
 * @property {string} project_id    From `payload.project.project_id`
 *                                  (Requirement 1.4).
 * @property {string} name          From `payload.project.name`
 *                                  (Requirement 1.4).
 * @property {string} last_modified Server-maintained timestamp
 *                                  (Requirements 1.4, 3.7).
 */

/**
 * Storage_Provider interface (Requirements 7.1, 7.5).
 *
 * This is an abstract base: every method throws "not implemented" so a concrete
 * provider (e.g. the default `File_Storage_Provider`) must override it. Because
 * this repository has no TypeScript types, the contract is expressed as a base
 * class plus the JSDoc typedefs above.
 */
export class StorageProvider {
  /**
   * List every stored project as a manifest entry — one entry per stored
   * project (Requirements 1.2, 7.5). An empty store yields an empty array.
   *
   * @returns {Promise<ManifestEntry[]>}
   */
  async list() {
    throw new Error('not implemented');
  }

  /**
   * Read a single project's stored record by `project_id`, or `null` when no
   * such project is stored (Requirements 2.2, 7.5).
   *
   * @param {string} _id The `project_id` to read.
   * @returns {Promise<StoredProject|null>} The record, or `null` when absent.
   */
  async read(_id) {
    throw new Error('not implemented');
  }

  /**
   * Create-or-replace a project's verbatim payload together with a
   * server-supplied `last_modified` timestamp (Requirements 3.7, 7.5). Returns
   * `{ created }` so the write handler can choose 201 (create) versus 200
   * (replace) without a separate existence probe (Requirements 3.1, 3.2).
   *
   * @param {string} _id           The `project_id` to store under.
   * @param {object} _payload      The Full_Project_Payload, stored verbatim.
   * @param {string} _lastModified ISO 8601 timestamp, supplied by the caller
   *                               (the write handler).
   * @returns {Promise<{created: boolean}>} `created=true` → 201, `false` → 200.
   */
  async put(_id, _payload, _lastModified) {
    throw new Error('not implemented');
  }

  /**
   * Remove all stored projects (Requirement 12.3 reset).
   *
   * @returns {Promise<number>} The number of projects removed, so the reset
   *   handler can report `{ cleared: <n> }` without a separate count step.
   */
  async clear() {
    throw new Error('not implemented');
  }
}
