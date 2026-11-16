/**
 * mcp.js: the methods of the Model Context Protocol this server answers:
 * `initialize`, `ping`, `tools/list` and `tools/call`. It declares the tools
 * capability alone, sends the client no request of its own, and answers no
 * notification.
 *
 * A tool call that names a tool of the list, with an object for its
 * arguments, is answered with a tool result: the object the tool answered
 * with, as `structuredContent` and serialized in one text block, with
 * `isError` set exactly when its `ok` is false. Arguments that do not match
 * the tool's input schema are such a failed call, and nothing runs. What is
 * not a call the server can start (a tool outside the list, arguments that
 * are not an object) is a protocol error, and so is a fault inside the server
 * itself.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import {
  isObject,
  resultResponse,
  errorResponse,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
} from './jsonrpc.js';
import { failure } from './failures.js';
import { checkArguments } from './tools.js';

/**
 * The protocol revisions the server speaks, the newest first. Both exchange
 * single messages; the revision before them has a server accept batches.
 */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18']);

/** The most tool calls in progress at once; a further call is not started. */
export const MAX_CALLS_IN_FLIGHT = 16;

/** What the server tells a client about using it, at `initialize`. */
const INSTRUCTIONS =
  'These tools run the commands of the Docent local control channel in the Chrome extension’s side panel. A person turns Local control on in the side panel and reads the pairing code it shows; call pair with that code first, then the other tools. Each call’s answer is a JSON object whose ok says whether it succeeded.';

/** The tool result that carries an object a tool answered with. */
function toolResult(answer) {
  return {
    content: [{ type: 'text', text: JSON.stringify(answer) }],
    structuredContent: answer,
    isError: answer.ok === false,
  };
}

/**
 * Create the handler of the server's MCP methods.
 *
 * @param {object} params
 * @param {{name: string, version: string}} params.serverInfo
 * @param {ReadonlyArray<object>} params.tools - the tool list
 * @param {(tool: object, args: object) => Promise<object>} params.callTool -
 *   carries out a call to a tool of the list whose arguments match the tool's schema, and answers
 *   an object with an `ok`
 * @returns {{handle: (message: object) => Promise<object|null>}} `handle`
 *   takes a message as jsonrpc.js reads one and answers the response to
 *   write, or null for a message that takes none
 */
export function createMcpHandler({ serverInfo, tools, callTool }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const listed = tools.map(({ name, title, description, inputSchema }) => ({
    name,
    title,
    description,
    inputSchema,
  }));
  let initialized = false;
  let callsInFlight = 0;

  function initialize(id, params) {
    if (initialized) return errorResponse(id, INVALID_REQUEST, 'Already initialized');
    if (typeof params.protocolVersion !== 'string') {
      return errorResponse(id, INVALID_PARAMS, 'Invalid params');
    }
    initialized = true;
    return resultResponse(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
        ? params.protocolVersion
        : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo,
      instructions: INSTRUCTIONS,
    });
  }

  async function call(id, params) {
    const tool = typeof params.name === 'string' ? byName.get(params.name) : undefined;
    if (tool === undefined) return errorResponse(id, INVALID_PARAMS, 'Unknown tool');
    const args = Object.hasOwn(params, 'arguments') ? params.arguments : {};
    if (!isObject(args)) return errorResponse(id, INVALID_PARAMS, 'Invalid params');

    const checked = checkArguments(tool.inputSchema, args);
    if (!checked.ok) {
      return resultResponse(id, toolResult(failure('invalid-arguments', checked.detail)));
    }
    if (callsInFlight >= MAX_CALLS_IN_FLIGHT) {
      return resultResponse(id, toolResult(failure('too-many-calls')));
    }
    callsInFlight += 1;
    try {
      return resultResponse(id, toolResult(await callTool(tool, args)));
    } catch {
      return errorResponse(id, INTERNAL_ERROR, 'Internal error');
    } finally {
      callsInFlight -= 1;
    }
  }

  return {
    async handle(message) {
      if (message.kind === 'invalid') {
        return errorResponse(message.id, message.code, message.message);
      }
      if (message.kind !== 'request') return null;
      const { id, method, params } = message;
      if (method === 'ping') return resultResponse(id, {});
      if (method === 'initialize') return initialize(id, params);
      if (!initialized) return errorResponse(id, INVALID_REQUEST, 'Not initialized');
      if (method === 'tools/list') return resultResponse(id, { tools: listed });
      if (method === 'tools/call') return call(id, params);
      return errorResponse(id, METHOD_NOT_FOUND, 'Method not found');
    },
  };
}
