/**
 * failures.js: the refusals that are this server's own, each with its fixed
 * text. A refusal of the control client keeps the control client's code and
 * text. The texts carry no value from a call, so none of them can carry a
 * pairing code or an argument.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** Every refusal of the server's own, by its code. */
export const FAILURES = Object.freeze({
  'invalid-arguments':
    'The arguments do not match the tool’s input schema, so nothing was sent to the panel.',
  'already-paired':
    'A panel is already paired. Pairing again takes a channel that has ended: turn Local control off in the side panel, then on again, and use the new code.',
  'pairing-under-way': 'An earlier pair call is still waiting for the panel.',
  'no-export-folder':
    'This server was started without an export folder (--export-dir), so nothing was sent to the panel.',
  'export-not-usable':
    'The panel answered without an export object and a project name, so no file was written.',
  'export-not-written':
    'The export file could not be written to the export folder. The panel counts the export all the same.',
  'too-many-calls':
    'Too many tool calls are in progress, so this one was not started. Wait for an answer and call again.',
});

/**
 * Build the refusal value for a code.
 *
 * @param {string} code - one of FAILURES' keys
 * @param {string} [detail] - one sentence added after the fixed text
 * @returns {{ok: false, code: string, message: string}}
 */
export function failure(code, detail) {
  const message = detail === undefined ? FAILURES[code] : `${FAILURES[code]} ${detail}`;
  return { ok: false, code, message };
}
