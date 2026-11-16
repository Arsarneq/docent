/**
 * tests/unit/jsonrpc.test.js: reading one JSON-RPC message from a line and
 * writing a response, as the MCP base protocol states them.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  readMessage,
  resultResponse,
  errorResponse,
  PARSE_ERROR,
  INVALID_REQUEST,
  INVALID_PARAMS,
} from '../../jsonrpc.js';

describe('readMessage', () => {
  it('reads a request with a text id', () => {
    assert.deepEqual(readMessage('{"jsonrpc":"2.0","id":"a","method":"ping"}'), {
      kind: 'request',
      id: 'a',
      method: 'ping',
      params: {},
    });
  });

  it('reads a request with a whole-number id and its params', () => {
    assert.deepEqual(
      readMessage('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"status"}}'),
      { kind: 'request', id: 7, method: 'tools/call', params: { name: 'status' } },
    );
  });

  it('reads a message without an id as a notification', () => {
    assert.deepEqual(readMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}'), {
      kind: 'notification',
      method: 'notifications/initialized',
      params: {},
    });
  });

  it('reads a result or an error without a method as a response', () => {
    assert.deepEqual(readMessage('{"jsonrpc":"2.0","id":1,"result":{}}'), { kind: 'response' });
    assert.deepEqual(
      readMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}}'),
      { kind: 'response' },
    );
  });

  it('answers text that is not JSON with a parse error and no id', () => {
    assert.deepEqual(readMessage('{"jsonrpc":'), {
      kind: 'invalid',
      id: null,
      code: PARSE_ERROR,
      message: 'Parse error',
    });
  });

  it('refuses a batch', () => {
    const read = readMessage('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
    assert.equal(read.kind, 'invalid');
    assert.equal(read.id, null);
    assert.equal(read.code, INVALID_REQUEST);
  });

  for (const [label, line] of [
    ['a JSON value that is not an object', '"ping"'],
    ['null', 'null'],
    ['a message without the version', '{"id":1,"method":"ping"}'],
    ['another version', '{"jsonrpc":"1.0","id":1,"method":"ping"}'],
    ['a method that is not text', '{"jsonrpc":"2.0","id":1,"method":5}'],
    ['a message with neither a method nor an answer', '{"jsonrpc":"2.0","id":1}'],
  ]) {
    it(`refuses ${label} as an invalid request`, () => {
      const read = readMessage(line);
      assert.equal(read.kind, 'invalid');
      assert.equal(read.code, INVALID_REQUEST);
    });
  }

  it('keeps a readable id on an invalid request, so its answer reaches the sender', () => {
    assert.equal(readMessage('{"jsonrpc":"1.0","id":4,"method":"ping"}').id, 4);
    assert.equal(readMessage('{"jsonrpc":"2.0","id":"q"}').id, 'q');
  });

  for (const [label, id] of [
    ['null', 'null'],
    ['a fraction', '1.5'],
    ['an object', '{}'],
    ['a boolean', 'true'],
  ]) {
    it(`refuses a request whose id is ${label}, answering with no id`, () => {
      const read = readMessage(`{"jsonrpc":"2.0","id":${id},"method":"ping"}`);
      assert.equal(read.kind, 'invalid');
      assert.equal(read.id, null);
      assert.equal(read.code, INVALID_REQUEST);
    });
  }

  it('refuses params that are not an object, with the request id', () => {
    assert.deepEqual(readMessage('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":[1]}'), {
      kind: 'invalid',
      id: 2,
      code: INVALID_PARAMS,
      message: 'Invalid params',
    });
  });

  it('drops a notification whose params are not an object', () => {
    assert.deepEqual(readMessage('{"jsonrpc":"2.0","method":"x","params":3}'), {
      kind: 'response',
    });
  });
});

describe('responses', () => {
  it('writes a result under the request id', () => {
    assert.deepEqual(resultResponse(3, { tools: [] }), {
      jsonrpc: '2.0',
      id: 3,
      result: { tools: [] },
    });
  });

  it('writes an error under the request id', () => {
    assert.deepEqual(errorResponse('a', -32601, 'Method not found'), {
      jsonrpc: '2.0',
      id: 'a',
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('writes an error for a message whose id could not be read without an id', () => {
    assert.deepEqual(errorResponse(null, PARSE_ERROR, 'Parse error'), {
      jsonrpc: '2.0',
      error: { code: PARSE_ERROR, message: 'Parse error' },
    });
  });

  it('adds data to an error when given', () => {
    assert.deepEqual(errorResponse(1, INVALID_PARAMS, 'x', { supported: ['a'] }).error.data, {
      supported: ['a'],
    });
  });
});
