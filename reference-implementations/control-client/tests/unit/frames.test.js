/**
 * tests/unit/frames.test.js: the frames' pure parts: reading what the panel
 * sends (a greeting, its proof, results) and writing what the local process
 * sends (its proof, commands), held to the frame rules of the control channel
 * specification (docs/api/control-channel.md, LC-4 to LC-9).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  MAX_COMMAND_FRAME_CHARS,
  MAX_ID_CHARS,
  parsePanelFrame,
  readHello,
  readPaired,
  readResult,
  buildPairFrame,
  buildCommandFrame,
} from '../../frames.js';

const NONCE = '000102030405060708090a0b0c0d0e0f';
const PROOF = '0269c0d2e863e07f8a9d5b49f5dc1e4202251c885577e12e8687cdc82a58fcfb';

describe('the protocol constants', () => {
  it('state version 1, the 16384-unit cap on frames the panel receives, and 64-character ids', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.equal(MAX_COMMAND_FRAME_CHARS, 16384);
    assert.equal(MAX_ID_CHARS, 64);
  });
});

describe('parsePanelFrame', () => {
  it('reads a text frame holding a JSON object', () => {
    assert.deepEqual(parsePanelFrame(Buffer.from('{"type":"hello"}'), false), {
      ok: true,
      message: { type: 'hello' },
    });
  });

  it('reads the same frame given as text', () => {
    assert.deepEqual(parsePanelFrame('{"type":"result"}', false), {
      ok: true,
      message: { type: 'result' },
    });
  });

  const refused = [
    ['a binary frame', Buffer.from('{"type":"hello"}'), true],
    ['malformed JSON', Buffer.from('{"type":'), false],
    ['a JSON array', Buffer.from('[{"type":"hello"}]'), false],
    ['a JSON string', Buffer.from('"hello"'), false],
    ['JSON null', Buffer.from('null'), false],
    ['an object without a type', Buffer.from('{"id":"1"}'), false],
    ['an object whose type is not text', Buffer.from('{"type":1}'), false],
  ];
  for (const [label, data, isBinary] of refused) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(parsePanelFrame(data, isBinary), { ok: false });
    });
  }
});

describe('readHello', () => {
  it('reads the panel nonce from a version 1 greeting', () => {
    assert.deepEqual(readHello({ type: 'hello', docent_control: 1, nonce: NONCE }), {
      ok: true,
      nonce: NONCE,
    });
  });

  it('tells another protocol version apart from a malformed greeting', () => {
    assert.deepEqual(readHello({ type: 'hello', docent_control: 2, nonce: NONCE }), {
      ok: false,
      code: 'unsupported-version',
    });
    assert.deepEqual(readHello({ type: 'hello', docent_control: '1', nonce: NONCE }), {
      ok: false,
      code: 'unsupported-version',
    });
  });

  const malformed = [
    ['another first frame', { type: 'result', id: null, ok: false, error: 'x' }],
    ['a greeting without a nonce', { type: 'hello', docent_control: 1 }],
    ['a nonce of the wrong form', { type: 'hello', docent_control: 1, nonce: NONCE.toUpperCase() }],
    ['a further field', { type: 'hello', docent_control: 1, nonce: NONCE, extra: true }],
  ];
  for (const [label, message] of malformed) {
    it(`refuses ${label} as a protocol error`, () => {
      assert.deepEqual(readHello(message), { ok: false, code: 'protocol-error' });
    });
  }
});

describe('readPaired', () => {
  it("reads the panel's proof", () => {
    assert.deepEqual(readPaired({ type: 'paired', proof: PROOF }), { ok: true, proof: PROOF });
  });

  const refused = [
    ['another frame', { type: 'result', id: null, ok: false, error: 'x' }],
    ['a proof that is not text', { type: 'paired', proof: 7 }],
    ['no proof', { type: 'paired' }],
    ['a further field', { type: 'paired', proof: PROOF, nonce: NONCE }],
  ];
  for (const [label, message] of refused) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(readPaired(message), { ok: false });
    });
  }
});

describe('readResult', () => {
  it('reads the id of a successful result, whatever further fields it carries', () => {
    assert.deepEqual(
      readResult({ type: 'result', id: 'c1', ok: true, project: null, notices: [] }),
      { ok: true, id: 'c1' },
    );
  });

  it('reads the id of a refusal carrying its error text', () => {
    assert.deepEqual(readResult({ type: 'result', id: 'c1', ok: false, error: 'No project' }), {
      ok: true,
      id: 'c1',
    });
  });

  it('reads a null id, the answer to a frame whose id the panel could not use', () => {
    assert.deepEqual(
      readResult({ type: 'result', id: null, ok: false, error: 'Frame too large' }),
      {
        ok: true,
        id: null,
      },
    );
  });

  const refused = [
    ['another frame', { type: 'paired', proof: PROOF }],
    ['no id', { type: 'result', ok: true }],
    ['an empty id', { type: 'result', id: '', ok: true }],
    ['an id longer than 64 characters', { type: 'result', id: 'x'.repeat(65), ok: true }],
    ['an id that is not text', { type: 'result', id: 1, ok: true }],
    ['no ok', { type: 'result', id: 'c1' }],
    ['an ok that is not a flag', { type: 'result', id: 'c1', ok: 'true' }],
    ['a refusal without its error text', { type: 'result', id: 'c1', ok: false }],
  ];
  for (const [label, message] of refused) {
    it(`refuses ${label}`, () => {
      assert.deepEqual(readResult(message), { ok: false });
    });
  }
});

describe('buildPairFrame', () => {
  it('writes exactly the three fields of the pair frame', () => {
    const text = buildPairFrame({ proof: PROOF, nonce: NONCE });
    assert.deepEqual(JSON.parse(text), { type: 'pair', proof: PROOF, nonce: NONCE });
    assert.deepEqual(Object.keys(JSON.parse(text)), ['type', 'proof', 'nonce']);
  });
});

describe('buildCommandFrame', () => {
  it('writes the four fields of a command frame', () => {
    const outcome = buildCommandFrame({ id: '1', command: 'project.create', args: { name: 'P' } });
    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(outcome.text), {
      type: 'command',
      id: '1',
      command: 'project.create',
      args: { name: 'P' },
    });
  });

  it('leaves args out for a command sent without arguments', () => {
    const outcome = buildCommandFrame({ id: '2', command: 'status' });
    assert.equal(outcome.ok, true);
    assert.deepEqual(JSON.parse(outcome.text), { type: 'command', id: '2', command: 'status' });
  });

  it('sends a command name the panel may refuse as it is, interpreting nothing', () => {
    const outcome = buildCommandFrame({ id: '3', command: 'project.delete', args: {} });
    assert.equal(outcome.ok, true);
    assert.equal(JSON.parse(outcome.text).command, 'project.delete');
  });

  const invalid = [
    ['a command name that is not text', { id: '1', command: 7 }],
    ['an empty command name', { id: '1', command: '' }],
    ['args that are an array', { id: '1', command: 'status', args: [] }],
    ['args that are null', { id: '1', command: 'status', args: null }],
    ['args that are text', { id: '1', command: 'status', args: 'x' }],
    ['args JSON cannot write', { id: '1', command: 'status', args: { n: 1n } }],
    ['an empty id', { id: '', command: 'status' }],
    ['an id longer than 64 characters', { id: 'x'.repeat(65), command: 'status' }],
  ];
  for (const [label, input] of invalid) {
    it(`refuses ${label} without writing a frame`, () => {
      assert.deepEqual(buildCommandFrame(input), { ok: false, code: 'invalid-command' });
    });
  }

  it('accepts a frame of exactly 16384 UTF-16 code units and refuses one unit more', () => {
    const base = buildCommandFrame({ id: '1', command: 'step.commit', args: { narration: '' } });
    const room = MAX_COMMAND_FRAME_CHARS - base.text.length;
    const fits = buildCommandFrame({
      id: '1',
      command: 'step.commit',
      args: { narration: 'a'.repeat(room) },
    });
    assert.equal(fits.ok, true);
    assert.equal(fits.text.length, MAX_COMMAND_FRAME_CHARS);
    assert.deepEqual(
      buildCommandFrame({
        id: '1',
        command: 'step.commit',
        args: { narration: 'a'.repeat(room + 1) },
      }),
      { ok: false, code: 'frame-too-large' },
    );
  });

  it('counts UTF-16 code units, so a character outside the basic plane counts twice', () => {
    const base = buildCommandFrame({ id: '1', command: 'step.commit', args: { narration: '' } });
    const room = MAX_COMMAND_FRAME_CHARS - base.text.length;
    // One astral character is two code units, so room - 1 of them plus one
    // astral character is one unit over.
    const over = buildCommandFrame({
      id: '1',
      command: 'step.commit',
      args: { narration: `${'a'.repeat(room - 1)}\u{1F600}` },
    });
    assert.deepEqual(over, { ok: false, code: 'frame-too-large' });
  });
});
