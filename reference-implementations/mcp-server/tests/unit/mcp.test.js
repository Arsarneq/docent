/**
 * tests/unit/mcp.test.js: the MCP methods the server answers, with the tools'
 * work replaced by a recording stand-in.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpHandler, PROTOCOL_VERSIONS, MAX_CALLS_IN_FLIGHT } from '../../mcp.js';
import { TOOLS } from '../../tools.js';
import { FAILURES } from '../../failures.js';

const SERVER_INFO = { name: 'docent-reference-mcp-server', version: '1.0.0' };

function handlerWith(callTool = async () => ({ ok: true })) {
  const calls = [];
  const handler = createMcpHandler({
    serverInfo: SERVER_INFO,
    tools: TOOLS,
    callTool: (tool, args) => {
      assert.equal(TOOLS.includes(tool), true);
      calls.push([tool.name, args]);
      return callTool(tool.name, args);
    },
  });
  return { handler, calls };
}

const request = (id, method, params = {}) => ({ kind: 'request', id, method, params });

const INITIALIZE = request(1, 'initialize', {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
});

async function initialized(callTool) {
  const built = handlerWith(callTool);
  await built.handler.handle(INITIALIZE);
  return built;
}

describe('initialize', () => {
  it('answers with the revision asked for, the tools capability alone, and its name', async () => {
    const { handler } = handlerWith();
    const response = await handler.handle(INITIALIZE);
    assert.equal(response.id, 1);
    assert.equal(response.result.protocolVersion, '2025-11-25');
    assert.deepEqual(response.result.capabilities, { tools: {} });
    assert.deepEqual(response.result.serverInfo, SERVER_INFO);
    assert.equal(typeof response.result.instructions, 'string');
  });

  it('speaks the two revisions that take no batches, the newest first', () => {
    assert.deepEqual(PROTOCOL_VERSIONS, ['2025-11-25', '2025-06-18']);
  });

  it('answers the older revision it speaks when asked for it', async () => {
    const { handler } = handlerWith();
    const response = await handler.handle(
      request(1, 'initialize', { ...INITIALIZE.params, protocolVersion: '2025-06-18' }),
    );
    assert.equal(response.result.protocolVersion, '2025-06-18');
  });

  for (const asked of ['2024-11-05', '2025-03-26', '2099-01-01', 'latest']) {
    it(`answers its newest revision when asked for ${asked}`, async () => {
      const { handler } = handlerWith();
      const response = await handler.handle(
        request(1, 'initialize', { ...INITIALIZE.params, protocolVersion: asked }),
      );
      assert.equal(response.result.protocolVersion, '2025-11-25');
    });
  }

  it('refuses an initialize without a revision', async () => {
    const { handler } = handlerWith();
    const response = await handler.handle(request(1, 'initialize', {}));
    assert.equal(response.error.code, -32602);
  });

  it('refuses a second initialize', async () => {
    const { handler } = await initialized();
    const response = await handler.handle({ ...INITIALIZE, id: 2 });
    assert.equal(response.id, 2);
    assert.equal(response.error.code, -32600);
  });
});

describe('before initialize', () => {
  it('answers ping', async () => {
    const { handler } = handlerWith();
    assert.deepEqual(await handler.handle(request('p', 'ping')), {
      jsonrpc: '2.0',
      id: 'p',
      result: {},
    });
  });

  for (const method of ['tools/list', 'tools/call']) {
    it(`refuses ${method}`, async () => {
      const { handler, calls } = handlerWith();
      const response = await handler.handle(request(1, method, { name: 'status' }));
      assert.equal(response.error.code, -32600);
      assert.deepEqual(calls, []);
    });
  }
});

describe('messages that take no answer', () => {
  it('answers no notification, known or not', async () => {
    const { handler } = await initialized();
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'tools/call']) {
      assert.equal(await handler.handle({ kind: 'notification', method, params: {} }), null);
    }
  });

  it('answers no response', async () => {
    const { handler } = await initialized();
    assert.equal(await handler.handle({ kind: 'response' }), null);
  });

  it('answers an unreadable message with its error', async () => {
    const { handler } = handlerWith();
    assert.deepEqual(
      await handler.handle({ kind: 'invalid', id: null, code: -32700, message: 'Parse error' }),
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
    );
  });
});

describe('methods', () => {
  it('answers ping with an empty result', async () => {
    const { handler } = await initialized();
    assert.deepEqual((await handler.handle(request(2, 'ping'))).result, {});
  });

  for (const method of ['resources/list', 'prompts/list', 'logging/setLevel', 'tools/delete']) {
    it(`refuses ${method} as a method it does not offer`, async () => {
      const { handler } = await initialized();
      const response = await handler.handle(request(2, method));
      assert.equal(response.error.code, -32601);
    });
  }
});

describe('tools/list', () => {
  it('lists each tool by name, title, description and input schema, and nothing else', async () => {
    const { handler } = await initialized();
    const response = await handler.handle(request(2, 'tools/list'));
    assert.deepEqual(
      response.result.tools.map((tool) => tool.name),
      TOOLS.map((tool) => tool.name),
    );
    for (const tool of response.result.tools) {
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name', 'title']);
    }
    assert.equal('nextCursor' in response.result, false);
  });
});

describe('tools/call', () => {
  it('runs the tool with its arguments and answers its object twice', async () => {
    const answer = { ok: true, project: { project_id: 'p1', name: 'Demo' } };
    const { handler, calls } = await initialized(async () => answer);
    const response = await handler.handle(
      request(3, 'tools/call', { name: 'project_create', arguments: { name: 'Demo' } }),
    );
    assert.deepEqual(calls, [['project_create', { name: 'Demo' }]]);
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        structuredContent: answer,
        isError: false,
      },
    });
  });

  it('reads absent arguments as none', async () => {
    const { handler, calls } = await initialized();
    await handler.handle(request(3, 'tools/call', { name: 'status' }));
    assert.deepEqual(calls, [['status', {}]]);
  });

  it('marks the call as failed exactly when the object says ok: false', async () => {
    const refusal = { ok: false, error: 'No open project' };
    const { handler } = await initialized(async () => refusal);
    const response = await handler.handle(request(3, 'tools/call', { name: 'status' }));
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.structuredContent, refusal);
    assert.equal(response.result.content[0].text, JSON.stringify(refusal));
  });

  it('answers arguments outside the schema as a failed call, and runs nothing', async () => {
    const { handler, calls } = await initialized();
    const response = await handler.handle(
      request(3, 'tools/call', { name: 'project_create', arguments: { name: 5 } }),
    );
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.code, 'invalid-arguments');
    assert.ok(response.result.structuredContent.message.startsWith(FAILURES['invalid-arguments']));
    assert.match(response.result.structuredContent.message, /"name"/);
    assert.deepEqual(calls, []);
  });

  for (const [label, params] of [
    ['a tool outside the list', { name: 'project_delete' }],
    ['a command name in place of a tool name', { name: 'project.create', arguments: {} }],
    ['no tool name', {}],
    ['a tool name that is not text', { name: 5 }],
    ['arguments that are not an object', { name: 'status', arguments: 'none' }],
    ['arguments that are a list', { name: 'status', arguments: [] }],
    ['arguments that are null', { name: 'status', arguments: null }],
  ]) {
    it(`refuses ${label} with a protocol error, and runs nothing`, async () => {
      const { handler, calls } = await initialized();
      const response = await handler.handle(request(3, 'tools/call', params));
      assert.equal(response.error.code, -32602);
      assert.equal('result' in response, false);
      assert.deepEqual(calls, []);
    });
  }

  it('does not repeat an unknown tool name', async () => {
    const { handler } = await initialized();
    const response = await handler.handle(request(3, 'tools/call', { name: '7K3MQ9XZ4HTRWB2N' }));
    assert.doesNotMatch(JSON.stringify(response), /7K3MQ9XZ4HTRWB2N/);
  });

  it('answers a tool that throws with an internal error carrying no detail', async () => {
    const { handler } = await initialized(async () => {
      throw new Error('secret detail');
    });
    const response = await handler.handle(request(3, 'tools/call', { name: 'status' }));
    assert.equal(response.error.code, -32603);
    assert.doesNotMatch(JSON.stringify(response), /secret detail/);
  });

  it('runs calls beside one another, and answers each under its own id', async () => {
    const gates = [];
    const { handler } = await initialized(
      (name) => new Promise((resolve) => gates.push(() => resolve({ ok: true, name }))),
    );
    const first = handler.handle(request('a', 'tools/call', { name: 'status' }));
    const second = handler.handle(request('b', 'tools/call', { name: 'recording_pause' }));
    gates[1]();
    assert.equal((await second).id, 'b');
    gates[0]();
    assert.equal((await first).result.structuredContent.name, 'status');
  });

  it('starts no call beyond the bound on calls in progress', async () => {
    const gates = [];
    const { handler, calls } = await initialized(
      () => new Promise((resolve) => gates.push(() => resolve({ ok: true }))),
    );
    const running = [];
    for (let index = 0; index < MAX_CALLS_IN_FLIGHT; index += 1) {
      running.push(handler.handle(request(index, 'tools/call', { name: 'status' })));
    }
    const over = await handler.handle(request('over', 'tools/call', { name: 'status' }));
    assert.equal(over.result.isError, true);
    assert.deepEqual(over.result.structuredContent, {
      ok: false,
      code: 'too-many-calls',
      message: FAILURES['too-many-calls'],
    });
    assert.equal(calls.length, MAX_CALLS_IN_FLIGHT);
    assert.equal(MAX_CALLS_IN_FLIGHT, 16);

    gates.shift()();
    await running[0];
    const next = handler.handle(request('next', 'tools/call', { name: 'status' }));
    for (const open of gates) open();
    assert.equal((await next).result.isError, false);
    await Promise.all(running);
  });

  it('frees a place when a tool throws', async () => {
    let fail = true;
    const { handler } = await initialized(async () => {
      if (fail) throw new Error('x');
      return { ok: true };
    });
    for (let index = 0; index < MAX_CALLS_IN_FLIGHT + 1; index += 1) {
      await handler.handle(request(index, 'tools/call', { name: 'status' }));
    }
    fail = false;
    const response = await handler.handle(request('after', 'tools/call', { name: 'status' }));
    assert.equal(response.result.isError, false);
  });
});
