/**
 * tests/integration/server.test.js: the server as a child process, driven
 * over stdio by the client of the official MCP SDK, with the panel played by
 * the Reference Control Client's stand-in (which follows the panel's side of
 * docs/api/control-channel.md and computes its proofs itself).
 *
 * The SDK's client checks every answer against the protocol's own schemas, so
 * a pass here holds the hand-written MCP layer to the protocol's
 * implementation. The last group speaks to the server directly, line by line,
 * to see exactly what it writes.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  EXAMPLE,
  accepts,
  dial,
  freePort,
  pairAsPanel,
  serveAsPanel,
} from '../../../control-client/tests/integration/fake-panel.js';

const SERVER = fileURLToPath(new URL('../../server.js', import.meta.url));

/** A value planted in an export document, so a test can look for it. */
const CAPTURED = 'captured-value-5ca1ab1e';

const PROJECT = { project_id: 'p-1', name: 'Demo project' };

const EXPORT_DOCUMENT = {
  docent_format: { platform: 'extension', schema_version: '3.0.0' },
  project: PROJECT,
  recordings: [{ name: 'First', steps: [{ actions: [{ type: 'click', value: CAPTURED }] }] }],
};

/** What the stand-in panel answers each command with, beyond the envelope. */
const PANEL_ANSWERS = {
  status: {
    ok: true,
    project: PROJECT,
    recording: null,
    capturing: false,
    pending_actions: 0,
    steps: 0,
    export_allowed: true,
    notices: [],
  },
  'project.create': { ok: true, project: PROJECT },
  'recording.create': { ok: true, recording: { recording_id: 'r-1', name: 'First' } },
  'recording.pause': { ok: true, capturing: false },
  'recording.resume': { ok: true, capturing: true },
  'step.commit': { ok: true, step: { logical_id: 's-1', step_number: 1, actions: 2 }, steps: 1 },
  'project.export': { ok: true, project: PROJECT, export: EXPORT_DOCUMENT },
};

let scratch;
let exportDir;
let port;
let closers;

beforeEach(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'docent-mcp-server-')));
  exportDir = path.join(scratch, 'exports');
  fs.mkdirSync(exportDir);
  port = await freePort();
  closers = [];
});

afterEach(async () => {
  for (const close of closers.reverse()) await close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Start the server under the SDK's client and complete the MCP handshake. */
async function connect({ withExportDir = true, pairTimeoutMs = 5000 } = {}) {
  const args = [SERVER, '--port', String(port), '--pair-timeout-ms', String(pairTimeoutMs)];
  if (withExportDir) args.push('--export-dir', exportDir);
  const transport = new StdioClientTransport({ command: process.execPath, args, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'docent-mcp-server-tests', version: '0.0.0' });
  await client.connect(transport);
  closers.push(() => client.close());
  return { client, stderr: () => stderr };
}

/** Call a tool and return its result with the object it carries. */
async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.isError, result.structuredContent.ok === false);
  return { result, answer: result.structuredContent };
}

/**
 * Call `pair` and play the panel's side of the pairing; then answer commands
 * from `answers`. Returns the stand-in's connection and the frames it read.
 */
async function pairWithPanel(client, answers = PANEL_ANSWERS) {
  const pairing = callTool(client, 'pair', { code: EXAMPLE.shown });
  const peer = await dial(port);
  closers.push(async () => peer.socket.terminate());
  const { localProofValid } = await pairAsPanel(peer);
  assert.equal(localProofValid, true);
  const { answer } = await pairing;
  assert.deepEqual(answer, { ok: true });
  const served = serveAsPanel(peer, (frame) => answers[frame.command] ?? null);
  return { peer, frames: served.frames };
}

describe('the MCP handshake and the tool list', () => {
  it('completes initialize with the official client, declaring tools alone', async () => {
    const { client } = await connect();
    assert.deepEqual(client.getServerCapabilities(), { tools: {} });
    assert.deepEqual(client.getServerVersion(), {
      name: 'docent-reference-mcp-server',
      version: JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        .version,
    });
    assert.match(client.getInstructions(), /pair/);
    assert.deepEqual(await client.ping(), {});
  });

  it('lists pair and one tool per command, each with an object schema', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'pair',
        'status',
        'project_create',
        'recording_create',
        'recording_pause',
        'recording_resume',
        'step_commit',
        'project_export',
      ],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it('refuses a tool outside the list with a protocol error', async () => {
    const { client } = await connect();
    await assert.rejects(
      () => client.callTool({ name: 'project_delete', arguments: {} }),
      (error) => error.code === -32602,
    );
  });

  it('refuses a method it does not offer', async () => {
    const { client } = await connect();
    await assert.rejects(
      () => client.listResources(),
      (error) => error.code === -32601,
    );
  });
});

describe('pairing', () => {
  it('listens only while a pair call waits', async () => {
    const { client } = await connect();
    assert.equal(await accepts(port), false);
    await pairWithPanel(client);
    assert.equal(await accepts(port), false);
  });

  it('answers a command before pairing as not paired', async () => {
    const { client } = await connect();
    const { result, answer } = await callTool(client, 'status', {});
    assert.equal(result.isError, true);
    assert.equal(answer.code, 'not-paired');
  });

  it('refuses a code of the wrong shape without listening', async () => {
    const { client } = await connect();
    const { answer } = await callTool(client, 'pair', { code: 'not-a-code' });
    assert.equal(answer.code, 'invalid-code');
    assert.equal(await accepts(port), false);
  });

  it('answers a panel that does not confirm the code, and pairs again with a new attempt', async () => {
    const { client } = await connect();
    const pairing = callTool(client, 'pair', { code: '0000-0000-0000-0000' });
    const peer = await dial(port);
    const { localProofValid } = await pairAsPanel(peer);
    assert.equal(localProofValid, false);
    assert.equal((await pairing).answer.code, 'pairing-refused');

    const { frames } = await pairWithPanel(client);
    assert.equal((await callTool(client, 'status', {})).answer.ok, true);
    assert.equal(frames.length, 1);
  });

  it('refuses a second pair while a panel is paired', async () => {
    const { client } = await connect();
    await pairWithPanel(client);
    const { answer } = await callTool(client, 'pair', { code: EXAMPLE.shown });
    assert.equal(answer.code, 'already-paired');
  });

  it('answers a command after the panel has gone with what ended the channel, then pairs again', async () => {
    const { client } = await connect();
    const { peer } = await pairWithPanel(client);
    peer.socket.close();
    await peer.closed;
    const { answer } = await callTool(client, 'status', {});
    assert.equal(answer.code, 'disconnected');

    await pairWithPanel(client);
    assert.equal((await callTool(client, 'status', {})).answer.ok, true);
  });

  it('answers a pair call nobody dials within the configured wait', async () => {
    const { client } = await connect({ pairTimeoutMs: 300 });
    const { answer } = await callTool(client, 'pair', { code: EXAMPLE.shown });
    assert.equal(answer.code, 'pairing-timeout');
  });
});

describe('commands', () => {
  it('sends each tool’s command, with its arguments alone, and answers the panel’s result', async () => {
    const { client } = await connect();
    const { frames } = await pairWithPanel(client);

    const calls = [
      ['status', {}, { command: 'status' }],
      [
        'project_create',
        { name: 'Demo project' },
        { command: 'project.create', args: { name: 'Demo project' } },
      ],
      [
        'recording_create',
        { name: 'First' },
        { command: 'recording.create', args: { name: 'First' } },
      ],
      ['recording_pause', {}, { command: 'recording.pause' }],
      ['recording_resume', {}, { command: 'recording.resume' }],
      [
        'step_commit',
        { narration: 'Open the cart' },
        { command: 'step.commit', args: { narration: 'Open the cart' } },
      ],
      [
        'step_commit',
        { step_type: 'validation', expect: 'absent' },
        { command: 'step.commit', args: { step_type: 'validation', expect: 'absent' } },
      ],
    ];
    for (const [name, args, sent] of calls) {
      const { result, answer } = await callTool(client, name, args);
      assert.equal(result.isError, false, name);
      assert.deepEqual(answer, PANEL_ANSWERS[sent.command], name);
    }
    assert.deepEqual(
      frames.map(({ id, ...frame }) => {
        assert.equal(typeof id, 'string');
        return frame;
      }),
      calls.map(([, , sent]) => ({ type: 'command', ...sent })),
    );
  });

  it('answers a panel refusal as a failed call carrying the panel’s text', async () => {
    const { client } = await connect();
    await pairWithPanel(client, {
      'recording.create': { ok: false, error: 'No open project' },
    });
    const { result, answer } = await callTool(client, 'recording_create', { name: 'First' });
    assert.equal(result.isError, true);
    assert.deepEqual(answer, { ok: false, error: 'No open project' });
  });

  it('answers arguments outside a tool’s schema as a failed call, and sends nothing', async () => {
    const { client } = await connect();
    const { frames } = await pairWithPanel(client);
    for (const [name, args] of [
      ['project_create', {}],
      ['project_create', { name: 'Demo', colour: 'red' }],
      ['status', { verbose: 'yes' }],
      ['step_commit', { step_type: 'observation' }],
    ]) {
      const { result, answer } = await callTool(client, name, args);
      assert.equal(result.isError, true, name);
      assert.equal(answer.code, 'invalid-arguments', name);
    }
    await callTool(client, 'status', {});
    assert.deepEqual(
      frames.map((frame) => frame.command),
      ['status'],
    );
  });

  it('matches answers to calls made behind one another', async () => {
    const { client } = await connect();
    await pairWithPanel(client);
    const [status, paused, resumed] = await Promise.all([
      callTool(client, 'status', {}),
      callTool(client, 'recording_pause', {}),
      callTool(client, 'recording_resume', {}),
    ]);
    assert.equal(status.answer.export_allowed, true);
    assert.equal(paused.answer.capturing, false);
    assert.equal(resumed.answer.capturing, true);
  });
});

describe('project_export', () => {
  it('writes the export into the export folder and answers its path and size, not the document', async () => {
    const { client } = await connect();
    await pairWithPanel(client);
    const before = Date.now();
    const { result, answer } = await callTool(client, 'project_export', {});
    const after = Date.now();

    assert.equal(result.isError, false);
    assert.deepEqual(Object.keys(answer).sort(), ['bytes', 'ok', 'path', 'project']);
    assert.deepEqual(answer.project, PROJECT);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(CAPTURED));

    assert.deepEqual(fs.readdirSync(exportDir), [path.basename(answer.path)]);
    assert.equal(path.dirname(answer.path), exportDir);
    const name = /^Demo_project_(\d+)\.docent\.json$/.exec(path.basename(answer.path));
    assert.ok(name, path.basename(answer.path));
    assert.ok(Number(name[1]) >= before && Number(name[1]) <= after);

    const text = fs.readFileSync(answer.path, 'utf8');
    assert.equal(text, JSON.stringify(EXPORT_DOCUMENT, null, 2));
    assert.equal(answer.bytes, fs.statSync(answer.path).size);
  });

  it('keeps a project whose name is a path inside the export folder', async () => {
    const hostile = { project_id: 'p-2', name: '../../outside/..\\x' };
    const { client } = await connect();
    await pairWithPanel(client, {
      'project.export': { ok: true, project: hostile, export: EXPORT_DOCUMENT },
    });
    const { answer } = await callTool(client, 'project_export', {});
    assert.equal(answer.ok, true);
    assert.equal(path.dirname(answer.path), exportDir);
    assert.deepEqual(fs.readdirSync(scratch), ['exports']);
    assert.equal(fs.readdirSync(exportDir).length, 1);
  });

  it('answers the panel’s refusal of an export and writes nothing', async () => {
    const { client } = await connect();
    await pairWithPanel(client, {
      'project.export': { ok: false, error: 'Export is not allowed' },
    });
    const { result, answer } = await callTool(client, 'project_export', {});
    assert.equal(result.isError, true);
    assert.deepEqual(answer, { ok: false, error: 'Export is not allowed' });
    assert.deepEqual(fs.readdirSync(exportDir), []);
  });

  it('is refused on a server started without an export folder, and the panel receives nothing', async () => {
    const { client } = await connect({ withExportDir: false });
    const { frames } = await pairWithPanel(client);
    const { answer } = await callTool(client, 'project_export', {});
    assert.equal(answer.code, 'no-export-folder');
    await callTool(client, 'status', {});
    assert.deepEqual(
      frames.map((frame) => frame.command),
      ['status'],
    );
  });
});

/** Start the server with nothing between the test and its streams. */
function startRaw(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const waiters = [];
  const lines = [];
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    while (stdout.includes('\n', lines.consumed ?? 0)) {
      const start = lines.consumed ?? 0;
      const end = stdout.indexOf('\n', start);
      lines.consumed = end + 1;
      const line = stdout.slice(start, end);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  closers.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    send: (message) =>
      child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    nextLine: () =>
      lines.length > 0
        ? Promise.resolve(lines.shift())
        : new Promise((resolve) => waiters.push(resolve)),
  };
}

const RAW_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw', version: '0' },
  },
};

describe('what the server writes', () => {
  it('writes MCP messages alone to its output, none to its error stream, and no pairing code', async () => {
    const raw = startRaw(['--port', String(port), '--export-dir', exportDir]);
    raw.send(RAW_INITIALIZE);
    assert.equal(JSON.parse(await raw.nextLine()).id, 1);
    raw.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    raw.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pair', arguments: { code: EXAMPLE.shown } },
    });
    const peer = await dial(port);
    closers.push(async () => peer.socket.terminate());
    const { pair } = await pairAsPanel(peer);
    assert.equal(JSON.parse(await raw.nextLine()).result.structuredContent.ok, true);
    serveAsPanel(peer, (frame) => PANEL_ANSWERS[frame.command] ?? null);

    raw.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_export' } });
    assert.equal(JSON.parse(await raw.nextLine()).result.isError, false);
    // An answer to a message whose id could not be read carries no id.
    raw.send('this is not JSON');
    assert.deepEqual(JSON.parse(await raw.nextLine()), {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
    });
    raw.send([RAW_INITIALIZE]);
    assert.deepEqual(Object.keys(JSON.parse(await raw.nextLine())), ['jsonrpc', 'error']);
    raw.send({ jsonrpc: '2.0', id: null, method: 'ping' });
    assert.deepEqual(Object.keys(JSON.parse(await raw.nextLine())), ['jsonrpc', 'error']);

    raw.child.stdin.end();
    assert.deepEqual(await raw.exited, { code: 0, signal: null });

    const written = raw.stdout().split('\n');
    assert.equal(written.pop(), '');
    // Every line is a message the official client's own schema reads.
    for (const line of written) JSONRPCMessageSchema.parse(JSON.parse(line));
    assert.equal(raw.stderr(), '');
    for (const secret of [EXAMPLE.shown, EXAMPLE.key, pair.proof, pair.nonce, CAPTURED]) {
      assert.equal(raw.stdout().includes(secret), false);
    }
  });

  it('ends when its input ends, closing the connection to the panel', async () => {
    const raw = startRaw(['--port', String(port)]);
    raw.send(RAW_INITIALIZE);
    await raw.nextLine();
    raw.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pair', arguments: { code: EXAMPLE.shown } },
    });
    const peer = await dial(port);
    await pairAsPanel(peer);
    await raw.nextLine();

    raw.child.stdin.end();
    assert.equal(await peer.closed, 1000);
    assert.deepEqual(await raw.exited, { code: 0, signal: null });
  });

  it('answers a call still waiting when its input ends, then ends', async () => {
    const raw = startRaw(['--port', String(port), '--pair-timeout-ms', '60000']);
    raw.send(RAW_INITIALIZE);
    await raw.nextLine();
    raw.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'pair', arguments: { code: EXAMPLE.shown } },
    });
    while (!(await accepts(port))) await new Promise((resolve) => setTimeout(resolve, 10));
    raw.child.stdin.end();
    const answer = JSON.parse(await raw.nextLine());
    assert.equal(answer.id, 2);
    assert.equal(answer.result.structuredContent.code, 'closed');
    assert.deepEqual(await raw.exited, { code: 0, signal: null });
  });

  it(
    'ends on a termination signal while a pair call waits',
    { skip: process.platform === 'win32' },
    async () => {
      const raw = startRaw(['--port', String(port), '--pair-timeout-ms', '60000']);
      raw.send(RAW_INITIALIZE);
      await raw.nextLine();
      raw.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'pair', arguments: { code: EXAMPLE.shown } },
      });
      while (!(await accepts(port))) await new Promise((resolve) => setTimeout(resolve, 10));
      raw.child.kill('SIGTERM');
      assert.deepEqual(await raw.exited, { code: 0, signal: null });
      assert.equal(await accepts(port), false);
    },
  );

  it('answers its newest revision to a client that asks for one it does not speak', async () => {
    const raw = startRaw(['--port', String(port)]);
    raw.send({
      ...RAW_INITIALIZE,
      params: { ...RAW_INITIALIZE.params, protocolVersion: '2024-11-05' },
    });
    assert.equal(JSON.parse(await raw.nextLine()).result.protocolVersion, '2025-11-25');
  });

  for (const [label, args, pattern] of [
    ['an option it does not define', ['--host', '0.0.0.0'], /does not define/],
    ['a port outside the range the panel dials', ['--port', '80'], /port must be/],
    ['an extension id of another form', ['--extension-id', 'abc'], /extensionId must be/],
    [
      'an export folder that does not exist',
      ['--export-dir', '/nonexistent/exports'],
      /--export-dir/,
    ],
    ['a wait of zero', ['--pair-timeout-ms', '0'], /pairTimeoutMs must be/],
  ]) {
    it(`refuses to start with ${label}: status 2, the reason on its error stream, nothing on its output`, async () => {
      const raw = startRaw(args);
      assert.deepEqual(await raw.exited, { code: 2, signal: null });
      assert.match(raw.stderr(), pattern);
      assert.match(raw.stderr(), /Usage:/);
      assert.equal(raw.stdout(), '');
    });
  }

  it('prints its options for --help and exits with status 0', async () => {
    const raw = startRaw(['--help']);
    assert.deepEqual(await raw.exited, { code: 0, signal: null });
    assert.match(raw.stderr(), /--export-dir/);
    assert.equal(raw.stdout(), '');
  });
});
