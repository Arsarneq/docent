/**
 * control-channel-host.test.js — Unit tests for the side panel's control
 * channel host: the on/off switch around one outward loopback socket.
 *
 * The host is driven with a fake socket factory and a hand-fired timer, so each
 * case states when the panel dials, what it shows, and every route by which the
 * channel turns itself off.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlChannelHost,
  CONNECT_RETRY_MS,
  CONNECT_TIMEOUT_MS,
  MAX_CONNECT_ATTEMPTS,
} from '../../sidepanel/control-channel-host.js';
import { computePairProof, formatPairingCode } from '../../sidepanel/control-channel.js';

/** A fake WebSocket: records what the host does and lets a case play the peer. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  /** The peer accepted the connection. */
  accept() {
    this.onopen?.();
  }
  /** The connection ended from the far side (or was never made). */
  drop() {
    this.close();
  }
  /** The peer sent a frame; resolves once the host has dealt with it. */
  deliver(message) {
    return this.onmessage?.({
      data: typeof message === 'string' ? message : JSON.stringify(message),
    });
  }
}

function harness({ execute } = {}) {
  const sockets = [];
  const changes = [];
  const timers = [];
  const executed = [];
  const grants = [];
  let seed = 0;
  const host = createControlChannelHost({
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Deterministic, and different on every call, so codes and nonces differ.
    fillRandom: (bytes) => bytes.fill(++seed),
    execute:
      execute ??
      (async (command, channel) => {
        executed.push(command);
        grants.push(channel);
        return { ok: true };
      }),
    onChange: (status) => changes.push(status),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const rawCode = () => host.status.code.replaceAll('-', '');
  return { host, sockets, changes, timers, executed, grants, rawCode };
}

/** The nonce the local process sends in its pair frame in these cases. */
const PEER_NONCE = '00112233445566778899aabbccddeeff';

/** Enable, accept the connection and complete the pairing. */
async function pairedHarness(options = {}) {
  const h = harness(options);
  h.host.enable(8765, options.enable);
  const code = h.rawCode();
  const socket = h.sockets[0];
  socket.accept();
  const { nonce } = socket.sent[0];
  await socket.deliver({
    type: 'pair',
    proof: await computePairProof(code, nonce, 'local'),
    nonce: PEER_NONCE,
  });
  return { ...h, socket, code };
}

/** An executor that exports the named projects in turn and runs nothing else. */
function exportingExecutor(names) {
  let next = 0;
  return async (command) => {
    if (command.name !== 'project.export') return { ok: true };
    const name = names[next++];
    if (name === null) return { ok: false, error: 'The project was not exported' };
    return { ok: true, project: { project_id: `p-${name}`, name }, export: { name } };
  };
}

describe('createControlChannelHost — off by default', () => {
  it('starts off, with no socket and no code', () => {
    const h = harness();
    assert.deepEqual(h.host.status, {
      state: 'off',
      port: null,
      code: null,
      notice: null,
      exportAllowed: false,
      exports: 0,
      lastExport: null,
    });
    assert.equal(h.sockets.length, 0);
  });

  it('refuses a bad port without dialling', () => {
    const h = harness();
    const result = h.host.enable('evil.example:80');
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.equal(h.sockets.length, 0);
    assert.equal(h.host.status.state, 'off');
  });
});

describe('createControlChannelHost — turning on', () => {
  it('dials loopback on the given port and shows a fresh code', () => {
    const h = harness();
    assert.deepEqual(h.host.enable(8765), { ok: true });
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, 'ws://127.0.0.1:8765');
    assert.equal(h.host.status.state, 'connecting');
    assert.equal(h.host.status.port, 8765);
    assert.match(h.host.status.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    assert.deepEqual(h.changes.at(-1), h.host.status);
  });

  it('refuses to turn on twice', () => {
    const h = harness();
    h.host.enable(8765);
    assert.equal(h.host.enable(8766).ok, false);
    assert.equal(h.sockets.length, 1);
  });

  it('makes a new code every time it is turned on', () => {
    const h = harness();
    h.host.enable(8765);
    const first = h.host.status.code;
    h.host.disable();
    h.host.enable(8765);
    assert.notEqual(h.host.status.code, first);
  });

  it('greets an accepted connection and waits for the proof', () => {
    const h = harness();
    h.host.enable(8765);
    h.sockets[0].accept();
    assert.equal(h.host.status.state, 'awaiting-pair');
    assert.equal(h.sockets[0].sent.length, 1);
    assert.equal(h.sockets[0].sent[0].type, 'hello');
  });

  it('keeps dialling with the same code while nothing answers', () => {
    const h = harness();
    h.host.enable(8765);
    const code = h.host.status.code;
    h.sockets[0].drop();
    assert.equal(h.host.status.state, 'connecting');
    assert.equal(h.timers.at(-1).ms, CONNECT_RETRY_MS);
    h.timers.at(-1).fn();
    assert.equal(h.sockets.length, 2);
    assert.equal(h.sockets[1].url, 'ws://127.0.0.1:8765');
    assert.equal(h.host.status.code, code);
  });

  it('counts a connection that does not open in time as unanswered', () => {
    const h = harness();
    h.host.enable(8765);
    const waiting = h.timers.at(-1);
    assert.equal(waiting.ms, CONNECT_TIMEOUT_MS);
    waiting.fn();
    assert.equal(h.sockets[0].closed, true);
    assert.equal(h.host.status.state, 'connecting');
    assert.equal(h.timers.at(-1).ms, CONNECT_RETRY_MS);
  });

  it('leaves an opened connection alone when its connect timer fires', () => {
    const h = harness();
    h.host.enable(8765);
    const waiting = h.timers.at(-1);
    h.sockets[0].accept();
    waiting.fn();
    assert.equal(h.sockets[0].closed, false);
    assert.equal(h.host.status.state, 'awaiting-pair');
  });

  it('uses a new nonce for every connection', async () => {
    const h = harness();
    h.host.enable(8765);
    h.sockets[0].drop();
    h.timers.at(-1).fn();
    h.sockets[1].accept();
    // The first socket never opened, so only the second greeted; a third
    // connection after a re-enable must not reuse its nonce.
    const firstNonce = h.sockets[1].sent[0].nonce;
    h.host.disable();
    h.host.enable(8765);
    h.sockets[2].accept();
    assert.notEqual(h.sockets[2].sent[0].nonce, firstNonce);
  });

  it('gives up and turns off after the stated number of attempts', () => {
    const h = harness();
    h.host.enable(8765);
    for (let attempt = 1; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
      h.sockets.at(-1).drop();
      h.timers.at(-1).fn();
    }
    assert.equal(h.sockets.length, MAX_CONNECT_ATTEMPTS);
    h.sockets.at(-1).drop();
    assert.equal(h.host.status.state, 'off');
    assert.equal(h.host.status.code, null);
    assert.match(h.host.status.notice, /8765/);
    assert.equal(h.sockets.length, MAX_CONNECT_ATTEMPTS);
  });
});

describe('createControlChannelHost — pairing', () => {
  it('pairs on a correct proof and stops showing the code', async () => {
    const h = await pairedHarness();
    assert.equal(h.host.status.state, 'paired');
    assert.equal(h.host.status.code, null);
    assert.deepEqual(h.socket.sent.at(-1), {
      type: 'paired',
      proof: await computePairProof(h.code, PEER_NONCE, 'panel'),
    });
  });

  it('turns off on a wrong proof, closing the socket and spending the code', async () => {
    const h = harness();
    h.host.enable(8765);
    const code = h.host.status.code;
    h.sockets[0].accept();
    await h.sockets[0].deliver({ type: 'pair', proof: '0'.repeat(64) });
    assert.equal(h.host.status.state, 'off');
    assert.equal(h.host.status.code, null);
    assert.equal(h.sockets[0].closed, true);
    assert.match(h.host.status.notice, /pairing/i);
    // No redial, and turning on again shows another code.
    assert.equal(h.sockets.length, 1);
    h.host.enable(8765);
    assert.notEqual(h.host.status.code, code);
  });

  it('turns off when an accepted connection ends before pairing — no second attempt', () => {
    const h = harness();
    h.host.enable(8765);
    h.sockets[0].accept();
    h.sockets[0].drop();
    assert.equal(h.host.status.state, 'off');
    assert.equal(h.sockets.length, 1);
    assert.equal(h.timers.filter((t) => t.ms === CONNECT_RETRY_MS).length, 0);
  });

  it('runs no command before pairing', async () => {
    const h = harness();
    h.host.enable(8765);
    h.sockets[0].accept();
    await h.sockets[0].deliver({ type: 'command', id: '1', command: 'status' });
    assert.deepEqual(h.executed, []);
    assert.equal(h.host.status.state, 'off');
  });
});

describe('createControlChannelHost — the export grant', () => {
  it('is off unless given at turn-on, and is gone when the channel turns off', () => {
    const h = harness();
    h.host.enable(8765);
    assert.equal(h.host.status.exportAllowed, false);
    h.host.disable();
    h.host.enable(8765, { allowExport: true });
    assert.equal(h.host.status.exportAllowed, true);
    assert.deepEqual(h.changes.at(-1), h.host.status);
    h.host.disable();
    assert.equal(h.host.status.exportAllowed, false);
    h.host.enable(8765);
    assert.equal(h.host.status.exportAllowed, false);
  });

  it('stays as given while the channel is on', () => {
    const h = harness();
    h.host.enable(8765, { allowExport: true });
    assert.equal(h.host.enable(8765, { allowExport: false }).ok, false);
    assert.equal(h.host.status.exportAllowed, true);
    const off = harness();
    off.host.enable(8765);
    assert.equal(off.host.enable(8765, { allowExport: true }).ok, false);
    assert.equal(off.host.status.exportAllowed, false);
  });

  it('accepts only true as a grant', () => {
    for (const value of ['yes', 1, {}, null, undefined]) {
      const h = harness();
      h.host.enable(8765, { allowExport: value });
      assert.equal(h.host.status.exportAllowed, false, String(value));
    }
  });

  it('hands the grant to the executor with every command', async () => {
    for (const allowExport of [false, true]) {
      const h = await pairedHarness({ enable: { allowExport } });
      await h.socket.deliver({ type: 'command', id: 'a', command: 'status' });
      await h.socket.deliver({ type: 'command', id: 'b', command: 'project.export' });
      assert.deepEqual(h.grants, [{ exportAllowed: allowExport }, { exportAllowed: allowExport }]);
    }
  });

  it('shows each export: the project name and a running count', async () => {
    const h = await pairedHarness({
      enable: { allowExport: true },
      execute: exportingExecutor(['Alpha', 'Beta']),
    });
    assert.equal(h.host.status.exports, 0);
    await h.socket.deliver({ type: 'command', id: 'a', command: 'project.export' });
    assert.equal(h.host.status.exports, 1);
    assert.equal(h.host.status.lastExport, 'Alpha');
    assert.deepEqual(h.changes.at(-1), h.host.status);
    await h.socket.deliver({ type: 'command', id: 'b', command: 'project.export' });
    assert.equal(h.host.status.exports, 2);
    assert.equal(h.host.status.lastExport, 'Beta');
    assert.equal(h.socket.sent.at(-1).export.name, 'Beta');
  });

  it('shows the export before its result is sent', async () => {
    const h = await pairedHarness({
      enable: { allowExport: true },
      execute: exportingExecutor(['Alpha']),
    });
    const shownWhenSent = [];
    const send = h.socket.send.bind(h.socket);
    h.socket.send = (text) => {
      shownWhenSent.push(h.host.status.exports);
      send(text);
    };
    await h.socket.deliver({ type: 'command', id: 'a', command: 'project.export' });
    assert.deepEqual(shownWhenSent, [1]);
  });

  it('counts no refused export and no other command', async () => {
    const h = await pairedHarness({
      enable: { allowExport: true },
      execute: exportingExecutor([null]),
    });
    await h.socket.deliver({ type: 'command', id: 'a', command: 'project.export' });
    await h.socket.deliver({ type: 'command', id: 'b', command: 'status' });
    assert.equal(h.host.status.exports, 0);
    assert.equal(h.host.status.lastExport, null);
  });

  it('forgets the grant and the export count when the channel turns off', async () => {
    const h = await pairedHarness({
      enable: { allowExport: true },
      execute: exportingExecutor(['Alpha']),
    });
    await h.socket.deliver({ type: 'command', id: 'a', command: 'project.export' });
    h.host.disable();
    assert.equal(h.host.status.exportAllowed, false);
    assert.equal(h.host.status.exports, 0);
    assert.equal(h.host.status.lastExport, null);
  });
});

describe('createControlChannelHost — paired', () => {
  it('runs a command through the executor and answers it', async () => {
    const h = await pairedHarness();
    await h.socket.deliver({
      type: 'command',
      id: 'a',
      command: 'project.create',
      args: { name: 'P' },
    });
    assert.deepEqual(h.executed, [{ id: 'a', name: 'project.create', args: { name: 'P' } }]);
    assert.deepEqual(h.socket.sent.at(-1), { type: 'result', id: 'a', ok: true });
  });

  it('turns off when the local process disconnects, without redialling', async () => {
    const h = await pairedHarness();
    h.socket.drop();
    assert.equal(h.host.status.state, 'off');
    assert.match(h.host.status.notice, /disconnected/i);
    assert.equal(h.sockets.length, 1);
  });

  it('turns off on request, closes the socket and runs nothing afterwards', async () => {
    const h = await pairedHarness();
    h.host.disable();
    assert.equal(h.host.status.state, 'off');
    assert.equal(h.host.status.notice, null);
    assert.equal(h.socket.closed, true);
    await h.socket.deliver({ type: 'command', id: 'a', command: 'status' });
    assert.deepEqual(h.executed, []);
  });

  it('ignores a retry timer that fires after it was turned off', () => {
    const h = harness();
    h.host.enable(8765);
    h.sockets[0].drop();
    h.host.disable();
    h.timers.at(-1).fn();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.host.status.state, 'off');
  });

  it('ignores events from a socket of an earlier session', async () => {
    const h = await pairedHarness();
    h.host.disable();
    h.host.enable(8765);
    const stale = h.sockets[0];
    stale.onclose?.();
    await stale.deliver({ type: 'command', id: 'a', command: 'status' });
    assert.equal(h.host.status.state, 'connecting');
    assert.deepEqual(h.executed, []);
  });

  it('shows the code in the display format of the pure core', () => {
    const h = harness();
    h.host.enable(8765);
    assert.equal(h.host.status.code, formatPairingCode(h.rawCode()));
  });
});
