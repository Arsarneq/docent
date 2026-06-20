/**
 * Storage_Provider contract for the Reference Sync Server.
 *
 * The server reaches stored projects ONLY through this interface, so the
 * persistence backend can be swapped without touching the request-handling
 * logic. A provider stores, for each project, the verbatim
 * `Full_Project_Payload` plus a server-maintained `last_modified` timestamp —
 * the timestamp is metadata kept ALONGSIDE the payload and is never merged into
 * it.
 *
 * @module storage/provider
 */

/**
 * A stored project record: the verbatim payload plus its server-maintained
 * `last_modified` timestamp.
 *
 * @typedef {Object} StoredProject
 * @property {object} payload       The Full_Project_Payload, stored VERBATIM.
 * The server never
 *                                  validates, reshapes, or interprets it.
 * @property {string} last_modified Server write timestamp, ISO 8601;
 * NOT part of the payload.
 */

/**
 * A single entry in the Project_Manifest returned by `GET /projects`.
 *
 * @typedef {Object} ManifestEntry
 * @property {string} project_id    From `payload.project.project_id`.
 * @property {string} name          From `payload.project.name`.
 * @property {string} last_modified Server-maintained timestamp.
 */

/**
 * Storage_Provider interface.
 *
 * This is an abstract base: every method throws "not implemented" so a concrete
 * provider (e.g. the default `File_Storage_Provider`) must override it. Because
 * this repository has no TypeScript types, the contract is expressed as a base
 * class plus the JSDoc typedefs above.
 */
export class StorageProvider {
  /**
   * List every stored project as a manifest entry — one entry per stored
   * project. An empty store yields an empty array.
   *
   * @returns {Promise<ManifestEntry[]>}
   */
  async list() {
    throw new Error('not implemented');
  }

  /**
   * Read a single project's stored record by `project_id`, or `null` when no
   * such project is stored.
   *
   * @param {string} _id The `project_id` to read.
   * @returns {Promise<StoredProject|null>} The record, or `null` when absent.
   */
  async read(_id) {
    throw new Error('not implemented');
  }

  /**
   * Create-or-replace a project's verbatim payload together with a
   * server-supplied `last_modified` timestamp. Returns
   * `{ created }` so the write handler can choose 201 (create) versus 200
   * (replace) without a separate existence probe.
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
   * Remove all stored projects (reset).
   *
   * @returns {Promise<number>} The number of projects removed, so the reset
   *   handler can report `{ cleared: <n> }` without a separate count step.
   */
  async clear() {
    throw new Error('not implemented');
  }
}
