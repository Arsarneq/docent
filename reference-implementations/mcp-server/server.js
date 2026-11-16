#!/usr/bin/env node
/**
 * server.js: the entry point of the Reference MCP Server, a local process
 * that offers the commands of the local control channel
 * (docs/api/control-channel.md) as tools of the Model Context Protocol, over
 * stdio. It reads the command line and joins the parts: one JSON-RPC message
 * per line in and out (stdio.js, jsonrpc.js), the MCP methods (mcp.js), the
 * tool list (tools.js), and the pairing and commands over the Reference
 * Control Client (session.js).
 *
 * Standard output carries MCP messages and nothing else. Standard error
 * carries the usage text and a refused start, and nothing once the server
 * reads messages. The server ends when its input ends, which closes the
 * connection to the panel.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

import { readOptions, USAGE } from './options.js';
import { openExportFolder } from './export-file.js';
import { createSession } from './session.js';
import { createMcpHandler } from './mcp.js';
import { readMessage } from './jsonrpc.js';
import { serveLines } from './stdio.js';
import { TOOLS } from './tools.js';

/** The exit status of a start the server refuses. */
const EXIT_USAGE = 2;

/** Refuse to start: say why on standard error, with the usage text. */
function refuseStart(message) {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

const read = readOptions(process.argv.slice(2));
if (!read.ok) refuseStart(read.message);
if (read.help) {
  process.stderr.write(USAGE);
  process.exit(0);
}

const { exportDir: givenExportDir, ...clientOptions } = read.options;
let exportDir;
if (givenExportDir !== undefined) {
  const folder = openExportFolder(givenExportDir);
  if (!folder.ok) refuseStart('--export-dir must name an existing folder.');
  exportDir = folder.dir;
}

let session;
try {
  session = createSession({ clientOptions, exportDir });
} catch (error) {
  // The control client states which of its options it refuses, and why.
  refuseStart(error.message);
}

const { name, version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const handler = createMcpHandler({
  serverInfo: { name, version },
  tools: TOOLS,
  callTool: session.call,
});

let ending = false;
/** End the session once: its calls still waiting are answered as closed. */
function endSession() {
  if (ending) return Promise.resolve();
  ending = true;
  return session.close();
}

// A client that stops reading has gone; there is nobody left to answer.
process.stdout.on('error', () => endSession().then(() => process.exit(0)));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => endSession().then(() => process.exit(0)));
}

await serveLines({
  input: process.stdin,
  output: process.stdout,
  handleLine: (line) => handler.handle(readMessage(line)),
  onInputEnd: endSession,
});
await endSession();
