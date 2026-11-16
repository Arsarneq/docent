/**
 * export-file.js: naming and writing the file an export is delivered as. The
 * export folder is the one place on disk the server writes to: a file's name
 * is made here from characters that cannot leave the folder, and the file is
 * created by this process, never written over.
 *
 * The document is written as the Export button's download is, as JSON with a
 * two-space indent (control-channel LC-8: the command delivers the document
 * the click downloads). Nothing here reads the document.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The extension of an export file. */
const EXTENSION = '.docent.json';

/** The longest name part taken from a project's name. */
const MAX_NAME_CHARS = 100;

/** The name part of a project whose name is empty. */
const UNNAMED = 'project';

/** How many names are tried for one export before it is given up. */
const MAX_NAME_ATTEMPTS = 100;

/**
 * The name part an export file takes from a project's name: its first 100
 * characters, each one that is not an ASCII letter, a digit, `_` or `-`
 * replaced by `_`. With no separator and no dot in it, the result is one
 * file name, and the part before the name's first dot ends in digits (the
 * export's time, or the number of a later attempt), so it is never a name a
 * platform reserves.
 */
function namePart(projectName) {
  const kept = projectName.slice(0, MAX_NAME_CHARS).replace(/[^A-Za-z0-9_-]/g, '_');
  return kept === '' ? UNNAMED : kept;
}

/**
 * The name of the file a project's export is written to.
 *
 * @param {string} projectName - the exported project's name
 * @param {number} time - the moment of the export, in milliseconds
 * @param {number} [attempt] - 1 for the first name tried; a later attempt
 *   carries its number, for a name that is already taken
 * @returns {string}
 */
export function exportFileName(projectName, time, attempt = 1) {
  const suffix = attempt === 1 ? '' : `_${attempt}`;
  return `${namePart(projectName)}_${time}${suffix}${EXTENSION}`;
}

/**
 * Check the export folder the server was started with.
 *
 * @param {string} dir - the folder as given on the command line
 * @returns {{ok: true, dir: string} | {ok: false}} `dir` is the folder's real
 *   path; a path that is not an existing folder is refused
 */
export function openExportFolder(dir) {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? { ok: true, dir: real } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Write an export document to a new file in the export folder.
 *
 * The file is created exclusively, so an existing file, or a link that holds
 * the name, is never written over or through: the next free name is taken. A
 * file whose writing fails after it was created is removed, so no part of a
 * document is left under an export's name.
 *
 * @param {object} params
 * @param {string} params.dir - the export folder's real path
 * @param {string} params.projectName - the exported project's name
 * @param {object} params.document - the export document, written as it is
 * @param {number} params.time - the moment of the export, in milliseconds
 * @param {Function} [params.open] - opens the file; node:fs's unless a test
 *   supplies its own
 * @returns {Promise<{ok: true, path: string, bytes: number} | {ok: false}>}
 *   the written file's path and its size in bytes
 */
export async function writeExportFile({
  dir,
  projectName,
  document,
  time,
  open = fs.promises.open,
}) {
  let text;
  try {
    text = JSON.stringify(document, null, 2);
  } catch {
    return { ok: false };
  }
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const file = path.join(dir, exportFileName(projectName, time, attempt));
    let handle;
    try {
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      return { ok: false };
    }
    try {
      await handle.writeFile(text);
      await handle.close();
      return { ok: true, path: file, bytes: Buffer.byteLength(text) };
    } catch {
      await handle.close().catch(() => {});
      await fs.promises.rm(file, { force: true }).catch(() => {});
      return { ok: false };
    }
  }
  return { ok: false };
}
