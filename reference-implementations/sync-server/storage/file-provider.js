/**
 * file-provider.js — the default File_Storage_Provider for the Reference Sync
 * Server.
 *
 * Persistence model: each project is one flat JSON file under a directory inside
 * the OS temp folder:
 *
 *   <os.tmpdir()>/docent-reference-sync-server/<project_id>.json
 *
 * Every file wraps the verbatim `Full_Project_Payload` alongside the
 * server-maintained `last_modified` timestamp:
 *
 *   { "last_modified": "2026-06-04T10:00:00.000Z", "payload": { ... } }
 *
 * The timestamp is stored ALONGSIDE the payload, never merged into it, so the
 * payload returned by `GET /projects/:id` stays byte-for-content identical to
 * what was written. Because the wrapper persists on
 * disk, the timestamp survives a restart within the same temp-folder session:
 * a fresh provider constructed over the same directory reads
 * the projects and their `last_modified` back unchanged.
 *
 * The storage directory base is injectable through the constructor so tests can
 * point each suite at a fresh temp dir; it defaults to
 * `<os.tmpdir()>/docent-reference-sync-server`. The directory is created on
 * construction if absent (recursive mkdir).
 *
 * Uses only Node.js built-in modules (`node:fs`, `node:path`, `node:os`).
 *
 * @module storage/file-provider
 */

import { mkdirSync } from 'node:fs';
import { access, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StorageProvider } from './provider.js';

/** Default storage directory name under the OS temp folder. */
const DEFAULT_DIR_NAME = 'docent-reference-sync-server';

/** Suffix used for every per-project file on disk. */
const FILE_SUFFIX = '.json';

/**
 * Default Storage_Provider that persists each project as a flat JSON file under
 * the OS temp folder.
 *
 * @augments StorageProvider
 */
export class FileStorageProvider extends StorageProvider {
  /**
   * The absolute path to the directory holding the per-project files.
   *
   * @type {string}
   */
  #storageDir;

  /**
   * @param {string} [storageDir] Optional override for the storage directory.
   *   Tests inject a fresh temp dir here; production omits it to use the default
   *   `<os.tmpdir()>/docent-reference-sync-server`. Created recursively on
   *   construction if it does not yet exist.
   */
  constructor(storageDir) {
    super();
    this.#storageDir = storageDir ?? path.join(os.tmpdir(), DEFAULT_DIR_NAME);
    // Create the storage directory on startup if absent.
    mkdirSync(this.#storageDir, { recursive: true });
  }

  /**
   * The directory this provider reads and writes. Exposed read-only so the
   * server can log it and tests can assert against it.
   *
   * @returns {string}
   */
  get storageDir() {
    return this.#storageDir;
  }

  /**
   * Resolve the on-disk file path for a `project_id`.
   *
   * The hostile-id defense runs here, at the single place that builds a path,
   * so every public method that resolves a path (`read`, `put`, and — via
   * `clear`/`list` deriving from real filenames — the rest) is protected
   * without each one repeating the check.
   *
   * @param {string} id The `project_id`.
   * @returns {string} Absolute path to `<storageDir>/<id>.json`.
   * @throws {Error} When `id` is unsafe (see {@link FileStorageProvider#assertSafeId}).
   */
  #filePath(id) {
    this.#assertSafeId(id);
    return path.join(this.#storageDir, `${id}${FILE_SUFFIX}`);
  }

  /**
   * Reject a `project_id` that could escape the storage directory before it is
   * ever used to build a file path. A legitimate
   * `project_id` is a client-supplied UUIDv7 (hex + hyphens) and is
   * filesystem-safe; this guard defends against a hostile id arriving through a
   * seed or PUT. It rejects:
   *
   *   - an absent, empty, or non-string id;
   *   - any id containing a path separator (`/` or `\`) or a NUL byte;
   *   - the `.` / `..` segments or any embedded `..`.
   *
   * Throws a clear Error; the write/seed handlers translate it into the
   * appropriate HTTP status (built in later tasks).
   *
   * @param {string} id The candidate `project_id`.
   * @throws {Error} When the id is missing, empty, not a string, or contains
   *   path-traversal characters.
   */
  #assertSafeId(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('Invalid project_id: must be a non-empty string.');
    }
    if (id.includes('/') || id.includes('\\') || id.includes('\0')) {
      throw new Error('Invalid project_id: must not contain path separators.');
    }
    if (id === '.' || id.includes('..')) {
      throw new Error('Invalid project_id: must not contain a ".." path segment.');
    }
  }

  /**
   * List every stored project as a manifest entry. Each entry's `project_id`
   * and `name` come from the wrapped
   * `payload.project`, and `last_modified` from the sibling timestamp — the
   * `docent_format` stamp and step internals are never read. An empty (or
   * absent) store yields an empty array.
   *
   * @returns {Promise<import('./provider.js').ManifestEntry[]>}
   */
  async list() {
    const files = await this.#listProjectFiles();
    const entries = [];
    for (const file of files) {
      const wrapper = await this.#readWrapper(path.join(this.#storageDir, file));
      if (wrapper === null) continue; // removed concurrently — skip it
      const project = wrapper.payload?.project ?? {};
      entries.push({
        project_id: project.project_id,
        name: project.name,
        last_modified: wrapper.last_modified,
      });
    }
    return entries;
  }

  /**
   * Read a single project's stored record by `project_id`, returning the
   * verbatim payload plus its `last_modified`, or `null` when no such project
   * is stored. The wrapper is unwrapped here so callers
   * only ever see `{ payload, last_modified }`.
   *
   * @param {string} id The `project_id` to read.
   * @returns {Promise<import('./provider.js').StoredProject|null>}
   */
  async read(id) {
    const wrapper = await this.#readWrapper(this.#filePath(id));
    if (wrapper === null) return null;
    return { payload: wrapper.payload, last_modified: wrapper.last_modified };
  }

  /**
   * Create-or-replace a project's verbatim payload together with its
   * server-supplied `last_modified`. The timestamp
   * is written into the file wrapper, never into the payload. `created`
   * reflects whether a file already existed before this write, so the write
   * handler can choose 201 (create) versus 200 (replace).
   *
   * @param {string} id           The `project_id` to store under.
   * @param {object} payload      The Full_Project_Payload, stored verbatim.
   * @param {string} lastModified ISO 8601 timestamp supplied by the caller.
   * @returns {Promise<{created: boolean}>} `created=true` → 201, `false` → 200.
   */
  async put(id, payload, lastModified) {
    const filePath = this.#filePath(id);
    const created = !(await this.#exists(filePath));
    const wrapper = { last_modified: lastModified, payload };
    await writeFile(filePath, JSON.stringify(wrapper, null, 2), 'utf8');
    return { created };
  }

  /**
   * Remove every stored project file and report how many were removed.
   * Only the per-project `.json` files are touched; an
   * absent directory counts as zero.
   *
   * @returns {Promise<number>} The number of projects removed.
   */
  async clear() {
    const files = await this.#listProjectFiles();
    let removed = 0;
    for (const file of files) {
      await rm(path.join(this.#storageDir, file));
      removed += 1;
    }
    return removed;
  }

  /**
   * List the per-project `.json` filenames in the storage directory. An absent
   * directory yields an empty list rather than throwing.
   *
   * @returns {Promise<string[]>}
   */
  async #listProjectFiles() {
    let entries;
    try {
      entries = await readdir(this.#storageDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((entry) => entry.endsWith(FILE_SUFFIX));
  }

  /**
   * Read and parse a wrapper file, returning `null` when the file is absent.
   *
   * @param {string} filePath
   * @returns {Promise<{last_modified: string, payload: object}|null>}
   */
  async #readWrapper(filePath) {
    let contents;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
    return JSON.parse(contents);
  }

  /**
   * Report whether a file currently exists.
   *
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async #exists(filePath) {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
