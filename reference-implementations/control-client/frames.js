/**
 * frames.js: the frames' pure parts, for the local process side of the local
 * control channel (docs/api/control-channel.md): reading the frames the panel
 * sends (`hello`, `paired`, `result`) and writing the ones the local process
 * sends (`pair`, `command`).
 *
 * Reading checks a frame's envelope only: which frame it is, and the fields the
 * specification states for that frame. A result's further fields are the
 * caller's to read; nothing here interprets them.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { isNonce } from './pairing.js';

/** The protocol version this module speaks (control-channel LC-4). */
export const PROTOCOL_VERSION = 1;

/**
 * The cap on a frame the panel receives, in UTF-16 code units, as a JavaScript
 * string counts length (control-channel LC-6). A command frame over it is
 * refused here, before it is sent.
 */
export const MAX_COMMAND_FRAME_CHARS = 16384;

/** The longest command id (control-channel LC-7). */
export const MAX_ID_CHARS = 64;

/** True when an object's own keys are exactly `keys`, in any order. */
function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** True for a plain object: not null, not an array. */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a command id of the stated form. */
function isId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_CHARS;
}

/**
 * Read one frame the panel sent: a text message holding a JSON object with a
 * text `type`.
 *
 * @param {Buffer|string} data - the message as the WebSocket delivered it
 * @param {boolean} isBinary - whether it arrived as a binary message
 * @returns {{ok: true, message: object} | {ok: false}}
 */
export function parsePanelFrame(data, isBinary) {
  if (isBinary) return { ok: false };
  let message;
  try {
    message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (!isObject(message) || typeof message.type !== 'string') return { ok: false };
  return { ok: true, message };
}

/**
 * Read the panel's greeting, the first frame on the connection. Another
 * protocol version is told apart from a malformed greeting, since a panel of
 * another version is one this module does not describe (control-channel LC-4).
 *
 * @param {object} message - a parsed frame
 * @returns {{ok: true, nonce: string} |
 *   {ok: false, code: 'unsupported-version'|'protocol-error'}}
 */
export function readHello(message) {
  if (message.type !== 'hello') return { ok: false, code: 'protocol-error' };
  if (message.docent_control !== PROTOCOL_VERSION)
    return { ok: false, code: 'unsupported-version' };
  if (!hasExactKeys(message, ['type', 'docent_control', 'nonce']) || !isNonce(message.nonce)) {
    return { ok: false, code: 'protocol-error' };
  }
  return { ok: true, nonce: message.nonce };
}

/**
 * Read the panel's `paired` frame, which carries its proof. Whether the proof
 * is right is for the pairing to check.
 *
 * @param {object} message - a parsed frame
 * @returns {{ok: true, proof: string} | {ok: false}}
 */
export function readPaired(message) {
  if (message.type !== 'paired' || !hasExactKeys(message, ['type', 'proof'])) return { ok: false };
  if (typeof message.proof !== 'string') return { ok: false };
  return { ok: true, proof: message.proof };
}

/**
 * Read a result frame's envelope (control-channel LC-9): its `id` (a command's,
 * or null for a frame the panel could not read an id from), its `ok` flag, and
 * on `ok: false` its `error` text. Its further fields are left as they are.
 *
 * @param {object} message - a parsed frame
 * @returns {{ok: true, id: string|null} | {ok: false}}
 */
export function readResult(message) {
  if (message.type !== 'result') return { ok: false };
  if (message.id !== null && !isId(message.id)) return { ok: false };
  if (typeof message.ok !== 'boolean') return { ok: false };
  if (message.ok === false && typeof message.error !== 'string') return { ok: false };
  return { ok: true, id: message.id };
}

/**
 * Write the `pair` frame: the local proof over the panel's nonce, and the
 * local process's own nonce (control-channel LC-4).
 *
 * @param {{proof: string, nonce: string}} params
 * @returns {string}
 */
export function buildPairFrame({ proof, nonce }) {
  return JSON.stringify({ type: 'pair', proof, nonce });
}

/**
 * Write a command frame (control-channel LC-7). The command's name and
 * arguments are sent as given: whether the panel carries the command out is
 * the panel's to answer. What is refused here is a frame that could not be
 * one, and a frame over the cap on frames the panel receives.
 *
 * @param {{id: string, command: string, args?: object}} params - `args` left
 *   out sends a frame without arguments
 * @returns {{ok: true, text: string} |
 *   {ok: false, code: 'invalid-command'|'frame-too-large'}}
 */
export function buildCommandFrame({ id, command, args }) {
  if (!isId(id) || typeof command !== 'string' || command.length === 0) {
    return { ok: false, code: 'invalid-command' };
  }
  if (args !== undefined && !isObject(args)) return { ok: false, code: 'invalid-command' };
  const frame =
    args === undefined ? { type: 'command', id, command } : { type: 'command', id, command, args };
  let text;
  try {
    text = JSON.stringify(frame);
  } catch {
    return { ok: false, code: 'invalid-command' };
  }
  if (text.length > MAX_COMMAND_FRAME_CHARS) return { ok: false, code: 'frame-too-large' };
  return { ok: true, text };
}
