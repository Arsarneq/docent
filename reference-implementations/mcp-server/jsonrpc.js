/**
 * jsonrpc.js: reading one JSON-RPC 2.0 message and writing a response, as the
 * base protocol of the Model Context Protocol states them. Plain data in and
 * out.
 *
 * A message is a request (it has a method and an id), a notification (a
 * method and no id), or a response, which this server never asked for and
 * drops. A request's id is text or a whole number, never null, and its params
 * are an object. A batch is refused: the protocol revisions the server speaks
 * do not use one.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** The JSON-RPC error codes this server answers with. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const VERSION = '2.0';

/**
 * True for a plain object: not null, not an array.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for an id a request may carry: text, or a whole number. */
function isId(value) {
  return typeof value === 'string' || Number.isSafeInteger(value);
}

function invalid(id, code, message) {
  return { kind: 'invalid', id, code, message };
}

/**
 * Read one line as a JSON-RPC message.
 *
 * @param {string} line - one line of the input, without its newline
 * @returns {{kind: 'request', id: string|number, method: string, params: object} |
 *   {kind: 'notification', method: string, params: object} |
 *   {kind: 'response'} |
 *   {kind: 'invalid', id: string|number|null, code: number, message: string}}
 *   `response` stands for every message that takes no answer and has nothing
 *   to run: a response, and a notification that could not be read as one
 */
export function readMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return invalid(null, PARSE_ERROR, 'Parse error');
  }
  if (!isObject(message)) return invalid(null, INVALID_REQUEST, 'Invalid request');
  const hasId = Object.hasOwn(message, 'id');
  const id = hasId && isId(message.id) ? message.id : null;
  if (message.jsonrpc !== VERSION) return invalid(id, INVALID_REQUEST, 'Invalid request');

  if (!Object.hasOwn(message, 'method')) {
    const answers = Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error');
    return answers ? { kind: 'response' } : invalid(id, INVALID_REQUEST, 'Invalid request');
  }
  if (typeof message.method !== 'string') return invalid(id, INVALID_REQUEST, 'Invalid request');
  if (hasId && id === null) return invalid(null, INVALID_REQUEST, 'Invalid request');

  const hasParams = Object.hasOwn(message, 'params');
  if (hasParams && !isObject(message.params)) {
    // A notification is never answered, an unreadable one included.
    return hasId ? invalid(id, INVALID_PARAMS, 'Invalid params') : { kind: 'response' };
  }
  const params = hasParams ? message.params : {};
  return hasId
    ? { kind: 'request', id, method: message.method, params }
    : { kind: 'notification', method: message.method, params };
}

/**
 * Write the response that carries a request's result.
 *
 * @param {string|number} id - the request's id
 * @param {object} result
 * @returns {object}
 */
export function resultResponse(id, result) {
  return { jsonrpc: VERSION, id, result };
}

/**
 * Write the response that carries an error.
 *
 * @param {string|number|null} id - the request's id, or null when it could
 *   not be read: the response then carries no id, the form the protocol
 *   states for that case (JSON-RPC's own null id is not an MCP message)
 * @param {number} code
 * @param {string} message
 * @param {object} [data] - further detail, left out when not given
 * @returns {object}
 */
export function errorResponse(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return id === null ? { jsonrpc: VERSION, error } : { jsonrpc: VERSION, id, error };
}
