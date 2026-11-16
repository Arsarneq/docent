/**
 * mcp-stdio.js — runs the Reference MCP Server as a child process and speaks
 * to it as an MCP client does over stdio: one JSON-RPC message per line on the
 * child's standard input, one per line back on its standard output.
 *
 * The suite takes no MCP dependency for this. The server's own integration
 * suite drives it with the official MCP client
 * (`reference-implementations/mcp-server/README.md`); here the four messages
 * a spec needs are written out, so the browser suite's install stays as it
 * is. The server and the control client it builds on are run from their own
 * folders, so both need their runtime packages installed (`npm ci --omit=dev`
 * in each).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(
  __dirname,
  '../../../../../reference-implementations/mcp-server/server.js',
);

/** How long `close()` waits for the server to end by itself before killing it. */
const EXIT_GRACE_MS = 5000;

/**
 * A port on 127.0.0.1 that was free a moment ago. The server listens only
 * while a pairing is awaited, so a spec picks the port before it starts one.
 *
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the Reference MCP Server with the given command line options and
 * complete the MCP handshake with it.
 *
 * @param {string[]} args The server's options, e.g. `['--port', '8765']`.
 * @returns {Promise<{
 *   listTools: () => Promise<object[]>,
 *   callTool: (name: string, args?: object) => Promise<object>,
 *   stdout: () => string,
 *   stderr: () => string,
 *   close: () => Promise<void>,
 * }>} `callTool` resolves with the tool result (`content`, `structuredContent`
 *   and `isError`), and rejects when the server answers with a protocol error
 *   or ends before answering.
 */
export async function startMcpServer(args) {
  const child = spawn(process.execPath, [SERVER_ENTRY, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  let ended = null;
  const waiting = new Map();

  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    stdout += `${line}\n`;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Kept in `stdout()` for the spec to read; it answers no request.
      return;
    }
    const waiter = waiting.get(message.id);
    if (!waiter) return;
    waiting.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
    } else {
      waiter.resolve(message.result);
    }
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      ended = new Error(
        `The MCP server ended (${signal ?? `status ${code}`}) before answering. ${stderr}`,
      );
      for (const waiter of waiting.values()) waiter.reject(ended);
      waiting.clear();
      resolve();
    });
  });
  // A write to a server that has ended is reported through `exit` above.
  child.stdin.on('error', () => {});

  function write(message) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  function request(method, params) {
    if (ended) return Promise.reject(ended);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }

  async function close() {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), EXIT_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'docent-extension-e2e', version: '0' },
    });
    write({ method: 'notifications/initialized' });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    listTools: async () => (await request('tools/list', {})).tools,
    callTool: (name, toolArgs = {}) => request('tools/call', { name, arguments: toolArgs }),
    stdout: () => stdout,
    stderr: () => stderr,
    close,
  };
}
