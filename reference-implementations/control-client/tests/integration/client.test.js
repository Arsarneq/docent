/**
 * tests/integration/client.test.js: the control client against a fake panel
 * that follows the panel's side of the control channel specification
 * (docs/api/control-channel.md): where it listens and for how long, whom it
 * accepts, the pairing in both directions, each command's round trip, the
 * frames it refuses from the panel, and how the channel ends.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import { setTimeout } from 'node:timers';

import {
  createControlClient,
  DEFAULT_EXTENSION_ID,
  DEFAULT_PORT,
  DEFAULT_PAIR_TIMEOUT_MS,
  DEFAULT_GREETING_TIMEOUT_MS,
  FAILURES,
  COMMANDS_MAY_HAVE_RUN,
} from '../../client.js';
import {
  EXAMPLE,
  STORE_EXTENSION_ID,
  STORE_ORIGIN,
  accepts,
  dial,
  freePort,
  pairAsPanel,
  proof,
  serveAsPanel,
} from './fake-panel.js';

// Every client a test makes is closed after it, whatever the test left open.
const clients = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** A client on a free port, drawing the specification's local nonce. */
async function makeClient(options = {}) {
  const port = await freePort();
  const client = createControlClient({
    port,
    pairTimeoutMs: 3000,
    randomBytes: () => Buffer.from(EXAMPLE.localNonce, 'hex'),
    ...options,
  });
  clients.push(client);
  return { client, port };
}

/** A paired client, its peer, and a fake panel answering through `handle`. */
async function pairedClient(handle = () => ({ ok: true }), options = {}) {
  const { client, port } = await makeClient(options);
  const pairing = client.pair(EXAMPLE.shown);
  const peer = await dial(port);
  await pairAsPanel(peer);
  assert.deepEqual(await pairing, { ok: true });
  const panel = serveAsPanel(peer, handle);
  return { client, port, peer, panel };
}

/**
 * Assert a failure value: its code and its fixed text, and nothing else. A
 * failure that ended a paired client with commands waiting carries the one
 * sentence on what those commands may have done.
 */
function assertFailure(outcome, code, { commandsWaiting = false } = {}) {
  const message = commandsWaiting ? `${FAILURES[code]} ${COMMANDS_MAY_HAVE_RUN}` : FAILURES[code];
  assert.deepEqual(outcome, { ok: false, code, message });
}

describe('defaults', () => {
  it("accept the published extension, on the panel's default port, for as long as the panel dials", () => {
    assert.equal(DEFAULT_EXTENSION_ID, STORE_EXTENSION_ID);
    assert.equal(DEFAULT_PORT, 8765);
    // The panel dials every 2 seconds, 150 times (control-channel LC-3).
    assert.equal(DEFAULT_PAIR_TIMEOUT_MS, 300000);
  });
});

describe('construction', () => {
  it('refuses an option it does not define, such as a host to listen on', () => {
    assert.throws(() => createControlClient({ host: '0.0.0.0' }), TypeError);
  });

  it('refuses a port outside the range the panel dials', () => {
    for (const port of [0, 1023, 65536, 8765.5, '8765', -1]) {
      assert.throws(() => createControlClient({ port }), RangeError, String(port));
    }
  });

  it('refuses an extension id that is not one', () => {
    for (const extensionId of ['', 'abc', 'A'.repeat(32), 'q'.repeat(32), 7]) {
      assert.throws(() => createControlClient({ extensionId }), TypeError, String(extensionId));
    }
  });

  it('refuses a greeting deadline that is not a positive whole number', () => {
    for (const greetingTimeoutMs of [0, -1, 1.5, '10']) {
      assert.throws(
        () => createControlClient({ greetingTimeoutMs }),
        RangeError,
        String(greetingTimeoutMs),
      );
    }
  });

  it('opens nothing until a pairing is asked for', async () => {
    const { client, port } = await makeClient();
    assert.equal(client.state, 'idle');
    assert.equal(client.address(), null);
    assert.equal(await accepts(port), false);
  });
});

describe('pairing', () => {
  it("pairs in both directions, matching the specification's worked example", async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    const { pair, localProofValid } = await pairAsPanel(peer);
    assert.deepEqual(pair, { type: 'pair', proof: EXAMPLE.localProof, nonce: EXAMPLE.localNonce });
    assert.equal(localProofValid, true);
    assert.deepEqual(await pairing, { ok: true });
    assert.equal(client.state, 'paired');
  });

  it('draws a new nonce from a strong source for each pairing by default', async () => {
    const port = await freePort();
    const client = createControlClient({ port, pairTimeoutMs: 3000 });
    clients.push(client);
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    const { pair, localProofValid } = await pairAsPanel(peer);
    assert.match(pair.nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(pair.nonce, EXAMPLE.localNonce);
    assert.equal(localProofValid, true);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('refuses a code of the wrong shape before it listens', async () => {
    const { client, port } = await makeClient();
    assertFailure(await client.pair('7K3M-Q9XZ-4HTR'), 'invalid-code');
    assert.equal(client.state, 'idle');
    assert.equal(await accepts(port), false);
  });

  it('pairs on the same client with the corrected code after a code of the wrong shape', async () => {
    const { client, port } = await makeClient();
    assertFailure(await client.pair('7K3M-Q9XZ-4HTR'), 'invalid-code');
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('accepts one pairing attempt only', async () => {
    const { client, port } = await makeClient();
    const first = client.pair(EXAMPLE.shown);
    assertFailure(await client.pair(EXAMPLE.shown), 'pairing-already-attempted');
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await first, { ok: true });
    assertFailure(await client.pair(EXAMPLE.shown), 'pairing-already-attempted');
  });

  it('closes the connection and pairs nothing when the panel proves another code', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    await pairAsPanel(peer, { answer: 'wrong' });
    assertFailure(await pairing, 'panel-proof-mismatch');
    await peer.closed;
    assert.equal(client.state, 'closed');
    assertFailure(await client.send('status'), 'panel-proof-mismatch');
  });

  it('reports a refused pairing when the panel closes the connection instead of answering', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    // The panel holds another code, so the local proof fails its check.
    const { localProofValid } = await pairAsPanel(peer, { code: '0123456789ABCDEF' });
    assert.equal(localProofValid, false);
    assertFailure(await pairing, 'pairing-refused');
  });

  it('closes a connection greeting with another protocol version as a protocol error, and goes on waiting', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const other = await dial(port);
    other.send({ type: 'hello', docent_control: 2, nonce: EXAMPLE.panelNonce });
    // LC-4: a local process that reads another version closes the connection.
    assert.equal(await other.closed, 1002);
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('reports another protocol version when no panel of this one paired in the window', async () => {
    const { client, port } = await makeClient({ pairTimeoutMs: 400 });
    const pairing = client.pair(EXAMPLE.shown);
    const other = await dial(port);
    other.send({ type: 'hello', docent_control: 2, nonce: EXAMPLE.panelNonce });
    await other.closed;
    // A connection that did nothing wrong is closed normally when the window ends.
    const silent = await dial(port);
    assertFailure(await pairing, 'unsupported-version');
    assert.equal(await silent.closed, 1000);
  });

  // Before the client has sent its pair frame, nothing has been attempted
  // (control-channel LC-5): the connection is dropped and the window stays open.
  const strayOpenings = [
    ['ends at once', (peer) => peer.socket.close()],
    ['sends a binary first frame', (peer) => peer.send(Buffer.from('{}'), { binary: true })],
    ['sends malformed JSON first', (peer) => peer.send('{"type":')],
    ['sends a command first', (peer) => peer.send({ type: 'command', id: '1', command: 'status' })],
    [
      'greets with a further field',
      (peer) => peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce, x: 1 }),
    ],
    [
      'greets with a frame over the size the pairing needs',
      (peer) =>
        peer.send({
          type: 'hello',
          docent_control: 1,
          nonce: EXAMPLE.panelNonce,
          pad: 'x'.repeat(20000),
        }),
    ],
  ];
  for (const [label, act] of strayOpenings) {
    it(`drops a connection that ${label}, and pairs the panel after it`, async () => {
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      const stray = await dial(port);
      await act(stray);
      await stray.closed;
      assert.equal(client.state, 'listening');
      const peer = await dial(port);
      await pairAsPanel(peer);
      assert.deepEqual(await pairing, { ok: true });
    });
  }

  it('drops a connection as soon as it has sent more than the pairing needs, before any frame is complete', async () => {
    // The fragment is never finished, so no frame completes: only the bound on
    // what a peer may send before pairing ends this connection before the
    // (default, 10 second) greeting deadline would.
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const stray = await dial(port);
    stray.socket.send('x'.repeat(20000), { fin: false });
    const outcome = await Promise.race([
      stray.closed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 1000)),
    ]);
    assert.equal(outcome, 'closed');
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('drops a connection that sends no greeting within the greeting deadline, freeing its place', async () => {
    const { client, port } = await makeClient({ greetingTimeoutMs: 150 });
    const pairing = client.pair(EXAMPLE.shown);
    const silent = await dial(port);
    assert.deepEqual(await dial(port), { refused: 409 });
    await silent.closed;
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('gives a peer 10 seconds to greet by default, as the panel gives its peer to pair', () => {
    assert.equal(DEFAULT_GREETING_TIMEOUT_MS, 10000);
  });

  it('ends the attempt on an oversized frame once its pair frame is sent', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce });
    await peer.next();
    peer.send({ type: 'paired', proof: 'x'.repeat(20000) });
    assertFailure(await pairing, 'frame-too-large-received');
    await peer.closed;
  });

  const badOpenings = [
    [
      'a result where the proof belongs',
      async (peer) => {
        peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce });
        await peer.next();
        peer.send({ type: 'result', id: null, ok: false, error: 'x' });
      },
    ],
    [
      'a proof frame with a further field',
      async (peer) => {
        peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce });
        const pair = await peer.next();
        peer.send({ type: 'paired', proof: proof(EXAMPLE.key, 'panel:', pair.nonce), extra: 1 });
      },
    ],
  ];
  for (const [label, act] of badOpenings) {
    it(`ends the attempt and closes the connection on ${label}`, async () => {
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      const peer = await dial(port);
      await act(peer);
      assertFailure(await pairing, 'protocol-error');
      await peer.closed;
      assert.equal(client.state, 'closed');
    });
  }

  it('times out when no panel connects, and stops listening', async () => {
    const { client, port } = await makeClient({ pairTimeoutMs: 150 });
    assertFailure(await client.pair(EXAMPLE.shown), 'pairing-timeout');
    assert.equal(await accepts(port), false);
    assert.equal(client.state, 'closed');
  });

  it('times out when a connected peer never completes the pairing, and closes it', async () => {
    const { client, port } = await makeClient({ pairTimeoutMs: 300 });
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    assertFailure(await pairing, 'pairing-timeout');
    await peer.closed;
    assert.equal(await accepts(port), false);
  });

  it('reports a port another process holds', async () => {
    const holder = net.createServer();
    const port = await freePort();
    await new Promise((resolve) => holder.listen({ port, host: '127.0.0.1' }, resolve));
    try {
      const client = createControlClient({ port, pairTimeoutMs: 1000 });
      clients.push(client);
      assertFailure(await client.pair(EXAMPLE.shown), 'port-in-use');
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it('closes a connection that never asked for a WebSocket when the attempt ends', async () => {
    const { client, port } = await makeClient({ pairTimeoutMs: 300 });
    const pairing = client.pair(EXAMPLE.shown);
    await waitFor(() => client.address() !== null);
    const raw = net.connect({ port, host: '127.0.0.1' });
    raw.on('error', () => {});
    const rawClosed = new Promise((resolve) => raw.once('close', resolve));
    await new Promise((resolve) => raw.once('connect', resolve));
    assertFailure(await pairing, 'pairing-timeout');
    await client.close();
    const outcome = await Promise.race([
      rawClosed.then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 1000)),
    ]);
    raw.destroy();
    assert.equal(outcome, 'closed');
  });

  it('ends the pairing with a failure value, sending no pair frame, when the random source gives the wrong length', async () => {
    const { client, port } = await makeClient({ randomBytes: () => Buffer.alloc(15) });
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce });
    assertFailure(await pairing, 'random-source-failed');
    const code = await peer.closed;
    // No pair frame was sent before the connection closed.
    assert.deepEqual(await peer.next(), { closed: code });
  });

  it('ends the pairing with a failure value, sending no pair frame, when the random source throws', async () => {
    const { client, port } = await makeClient({
      randomBytes: () => {
        throw new Error('no entropy');
      },
    });
    const pairing = client.pair(EXAMPLE.shown);
    const peer = await dial(port);
    peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce });
    assertFailure(await pairing, 'random-source-failed');
    await peer.closed;
  });

  it('ends a pairing still awaited when the client is closed', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    await client.close();
    assertFailure(await pairing, 'closed');
    assert.equal(await accepts(port), false);
  });
});

describe('where and while it listens (control-channel LC-3)', () => {
  it('listens on 127.0.0.1 alone, on the configured port', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    assert.equal(client.state, 'listening');
    await waitFor(() => client.address() !== null);
    assert.deepEqual(client.address(), { address: '127.0.0.1', port, family: 'IPv4' });
    await client.close();
    await pairing;
  });

  it(
    'is not reachable on another loopback address',
    { skip: process.platform !== 'linux' },
    async () => {
      // Linux answers the whole 127.0.0.0/8 block on its loopback interface, so
      // a wildcard or a block-wide bind would accept a connection here.
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      await waitFor(() => client.address() !== null);
      assert.equal(await accepts(port, '127.0.0.2'), false);
      await client.close();
      await pairing;
    },
  );

  const external = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
  it(
    "is not reachable on the computer's network addresses",
    { skip: external === undefined ? 'no non-loopback IPv4 address here' : false },
    async () => {
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      await waitFor(() => client.address() !== null);
      assert.equal(await accepts(port, external.address), false);
      await client.close();
      await pairing;
    },
  );

  it('holds the port so no other process binds it, on the loopback literal or the wildcard', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    await waitFor(() => client.address() !== null);
    // The intruder also asks to share the port, which succeeds wherever the
    // holder's own socket allows sharing.
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      for (const reusePort of [false, true]) {
        if (reusePort && process.platform !== 'linux') continue;
        const intruder = net.createServer();
        const error = await new Promise((resolve) => {
          intruder.once('error', resolve);
          intruder.listen({ port, host, reusePort }, () => resolve(null));
        });
        if (error === null) await new Promise((resolve) => intruder.close(resolve));
        assert.equal(error?.code, 'EADDRINUSE', `${host} reusePort=${reusePort}`);
      }
    }
    await client.close();
    await pairing;
  });

  it('stops listening once the panel has paired, and keeps the paired connection', async () => {
    const { client, port, peer, panel } = await pairedClient(() => ({
      ok: true,
      capturing: false,
    }));
    assert.equal(client.address(), null);
    assert.equal(await accepts(port), false);
    const outcome = await client.send('recording.pause');
    assert.equal(outcome.ok, true);
    assert.equal(panel.frames.length, 1);
    assert.equal(peer.socket.readyState, 1);
  });
});

describe('whom it accepts', () => {
  it("accepts the Origin of a configured extension id in place of the store's", async () => {
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const { client, port } = await makeClient({ extensionId });
    const pairing = client.pair(EXAMPLE.shown);
    assert.deepEqual(await dial(port), { refused: 403 });
    const peer = await dial(port, { origin: `chrome-extension://${extensionId}` });
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  const wrongOrigins = [
    ['another extension', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
    ['a web page', 'https://example.com'],
    ['the store origin with a trailing slash', `${STORE_ORIGIN}/`],
    ['the store origin in another case', STORE_ORIGIN.toUpperCase()],
    ['no Origin at all', null],
  ];
  for (const [label, origin] of wrongOrigins) {
    it(`refuses ${label}, and goes on waiting for the panel`, async () => {
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      assert.deepEqual(await dial(port, { origin }), { refused: 403 });
      const peer = await dial(port);
      await pairAsPanel(peer);
      assert.deepEqual(await pairing, { ok: true });
    });
  }

  it('answers a plain HTTP request with a refusal, and goes on waiting', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    await waitFor(() => client.address() !== null);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 426);
    const peer = await dial(port);
    await pairAsPanel(peer);
    assert.deepEqual(await pairing, { ok: true });
  });

  it('refuses a second connection while the first is pairing', async () => {
    const { client, port } = await makeClient();
    const pairing = client.pair(EXAMPLE.shown);
    const first = await dial(port);
    assert.deepEqual(await dial(port), { refused: 409 });
    await pairAsPanel(first);
    assert.deepEqual(await pairing, { ok: true });
  });
});

describe('commands and their results', () => {
  // One round trip per command of the closed set (control-channel LC-7), with
  // results of the shapes LC-9 states. The client returns each result as the
  // panel sent it.
  const roundTrips = [
    [
      'status',
      undefined,
      {
        ok: true,
        project: { project_id: 'p1', name: 'P' },
        recording: null,
        capturing: false,
        pending_actions: 0,
        steps: 0,
        export_allowed: false,
        notices: [],
      },
    ],
    [
      'project.create',
      { name: 'Checkout' },
      { ok: true, project: { project_id: 'p2', name: 'Checkout' } },
    ],
    [
      'recording.create',
      { name: 'Happy path' },
      { ok: true, recording: { recording_id: 'r1', name: 'Happy path' } },
    ],
    ['recording.pause', undefined, { ok: true, capturing: false }],
    ['recording.resume', undefined, { ok: true, capturing: true }],
    [
      'step.commit',
      { narration: 'Open the cart' },
      { ok: true, step: { logical_id: 's1', step_number: 1, actions: 3 }, steps: 1 },
    ],
    [
      'step.commit',
      { step_type: 'validation', expect: 'absent' },
      { ok: true, step: { logical_id: 's2', step_number: 2, actions: 1 }, steps: 2 },
    ],
    [
      'project.export',
      undefined,
      {
        ok: true,
        project: { project_id: 'p2', name: 'Checkout' },
        export: { docent_format: {}, recordings: [] },
      },
    ],
  ];
  for (const [command, args, fields] of roundTrips) {
    it(`sends ${command}${args ? ` ${JSON.stringify(args)}` : ''} and returns its result unchanged`, async () => {
      const { client, panel } = await pairedClient(() => fields);
      const outcome = await client.send(command, args);
      const [frame] = panel.frames;
      const expectedFrame = { type: 'command', id: frame.id, command };
      if (args !== undefined) expectedFrame.args = args;
      assert.deepEqual(frame, expectedFrame);
      assert.ok(frame.id.length >= 1 && frame.id.length <= 64);
      assert.deepEqual(outcome, { ok: true, result: { type: 'result', id: frame.id, ...fields } });
    });
  }

  it("returns the panel's refusal as a result, leaving its meaning to the caller", async () => {
    const refusal = { ok: false, error: 'No project is open' };
    const { client, panel } = await pairedClient(() => refusal);
    const outcome = await client.send('recording.create', { name: 'R' });
    assert.deepEqual(outcome, {
      ok: true,
      result: { type: 'result', id: panel.frames[0].id, ...refusal },
    });
  });

  it('receives an export larger than the cap on frames the panel receives', async () => {
    const big = {
      ok: true,
      project: { project_id: 'p', name: 'P' },
      export: { blob: 'x'.repeat(200000) },
    };
    const { client } = await pairedClient(() => big);
    const outcome = await client.send('project.export');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.export.blob.length, 200000);
  });

  it('gives each command its own id and matches results sent behind one another', async () => {
    let n = 0;
    const { client, panel } = await pairedClient(() => ({ ok: true, steps: ++n }));
    const outcomes = await Promise.all([
      client.send('status'),
      client.send('status'),
      client.send('status'),
    ]);
    const ids = panel.frames.map((frame) => frame.id);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.result.id, outcome.result.steps]),
      [
        [ids[0], 1],
        [ids[1], 2],
        [ids[2], 3],
      ],
    );
  });

  it('matches results by id when they arrive out of order', async () => {
    const held = [];
    const { client, peer } = await pairedClient((frame) => {
      held.push(frame);
      if (held.length === 2) {
        peer.send({ type: 'result', id: held[1].id, ok: true, steps: 2 });
        peer.send({ type: 'result', id: held[0].id, ok: true, steps: 1 });
      }
      return null;
    });
    const [first, second] = await Promise.all([client.send('status'), client.send('status')]);
    assert.equal(first.result.steps, 1);
    assert.equal(second.result.steps, 2);
  });

  it('gives a result with a null id to the oldest command still waiting, as results come in order', async () => {
    const { client } = await pairedClient(() => ({
      id: null,
      ok: false,
      error: 'Frame too large',
    }));
    const outcome = await client.send('status');
    assert.deepEqual(outcome, {
      ok: true,
      result: { type: 'result', id: null, ok: false, error: 'Frame too large' },
    });
  });

  it('refuses locally, sending nothing, a command frame over the cap on frames the panel receives', async () => {
    const { client, panel } = await pairedClient();
    assertFailure(
      await client.send('step.commit', { narration: 'a'.repeat(16384) }),
      'frame-too-large',
    );
    assertFailure(await client.send('status', []), 'invalid-command');
    const outcome = await client.send('status');
    assert.equal(outcome.ok, true);
    assert.equal(panel.frames.length, 1);
  });

  it('refuses a command before pairing', async () => {
    const { client } = await makeClient();
    assertFailure(await client.send('status'), 'not-paired');
  });
});

describe('frames it refuses from the panel after pairing', () => {
  const refusals = [
    ['a binary frame', (peer) => peer.send(Buffer.from('{}'), { binary: true }), 'protocol-error'],
    ['malformed JSON', (peer) => peer.send('{"type":"result",'), 'protocol-error'],
    ['a JSON value other than an object', (peer) => peer.send('[1]'), 'protocol-error'],
    [
      'a frame of another type',
      (peer) => peer.send({ type: 'hello', docent_control: 1, nonce: EXAMPLE.panelNonce }),
      'protocol-error',
    ],
    ['a result without ok', (peer, id) => peer.send({ type: 'result', id }), 'protocol-error'],
    [
      'a result for no command sent',
      (peer) => peer.send({ type: 'result', id: 'nobody', ok: true }),
      'protocol-error',
    ],
  ];
  for (const [label, act, code] of refusals) {
    it(`closes the connection on ${label}, ending the command waiting`, async () => {
      const { client, peer } = await pairedClient((frame) => {
        act(peer, frame.id);
        return null;
      });
      assertFailure(await client.send('status'), code, { commandsWaiting: true });
      await peer.closed;
      assertFailure(await client.closed, code, { commandsWaiting: true });
      assert.equal(client.state, 'closed');
    });
  }

  it('closes the connection on a frame over its own receive bound', async () => {
    const { client, peer } = await pairedClient(() => ({ ok: true, export: 'x'.repeat(20000) }), {
      maxFrameBytes: 16384,
    });
    assertFailure(await client.send('project.export'), 'frame-too-large-received', {
      commandsWaiting: true,
    });
    assert.equal(await peer.closed, 1009);
    assertFailure(await client.closed, 'frame-too-large-received', { commandsWaiting: true });
  });

  it('refuses a receive bound that is not a whole number of bytes of at least the pre-proof bound', () => {
    for (const maxFrameBytes of [0, -1, 16383, 16384.5, '16384']) {
      assert.throws(
        () => createControlClient({ maxFrameBytes }),
        RangeError,
        String(maxFrameBytes),
      );
    }
  });
});

describe('the end of the channel', () => {
  it('closes the connection when the caller closes, ending the commands waiting', async () => {
    const { client, peer } = await pairedClient(() => null);
    const waiting = client.send('status');
    await client.close();
    assertFailure(await waiting, 'closed', { commandsWaiting: true });
    assert.equal(await peer.closed, 1000);
    assertFailure(await client.closed, 'closed', { commandsWaiting: true });
    assertFailure(await client.send('status'), 'closed', { commandsWaiting: true });
    assert.equal(client.state, 'closed');
  });

  it('reports the panel turning the channel off, ending the commands waiting', async () => {
    const { client, peer } = await pairedClient(() => {
      peer.socket.close(1000);
      return null;
    });
    assertFailure(await client.send('status'), 'disconnected', { commandsWaiting: true });
    assertFailure(await client.closed, 'disconnected', { commandsWaiting: true });
    assertFailure(await client.send('status'), 'disconnected', { commandsWaiting: true });
  });

  it('leaves the sentence on waiting commands out when none was waiting', async () => {
    const { client, peer } = await pairedClient();
    peer.socket.close(1000);
    assertFailure(await client.closed, 'disconnected');
    assertFailure(await client.send('status'), 'disconnected');
  });

  it('can be closed more than once', async () => {
    const { client } = await pairedClient();
    await client.close();
    await client.close();
    assert.equal(client.state, 'closed');
  });
});

describe('what it keeps to itself', () => {
  it('states fixed failure texts that carry no code and no proof', () => {
    assert.deepEqual(Object.keys(FAILURES).sort(), [
      'closed',
      'disconnected',
      'frame-too-large',
      'frame-too-large-received',
      'invalid-code',
      'invalid-command',
      'listen-failed',
      'not-paired',
      'pairing-already-attempted',
      'pairing-refused',
      'pairing-timeout',
      'panel-proof-mismatch',
      'port-in-use',
      'protocol-error',
      'random-source-failed',
      'unsupported-version',
    ]);
    assert.ok(Object.isFrozen(FAILURES));
    // The sentence on waiting commands is stated once, never inside a text.
    assert.equal(typeof COMMANDS_MAY_HAVE_RUN, 'string');
    for (const [code, message] of [
      ...Object.entries(FAILURES),
      ['sentence', COMMANDS_MAY_HAVE_RUN],
    ]) {
      if (code !== 'sentence') assert.ok(!message.includes(COMMANDS_MAY_HAVE_RUN), code);
      assert.equal(typeof message, 'string', code);
      for (const secret of [EXAMPLE.shown, EXAMPLE.key, EXAMPLE.localProof, EXAMPLE.panelProof]) {
        assert.ok(!message.includes(secret), code);
      }
    }
  });

  it('writes nothing to the console, and returns no secret, through a failed pairing', async () => {
    const written = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const saved = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args) => written.push(args);
    try {
      const { client, port } = await makeClient();
      const pairing = client.pair(EXAMPLE.shown);
      const peer = await dial(port);
      await pairAsPanel(peer, { answer: 'wrong' });
      const outcome = await pairing;
      const text = JSON.stringify(outcome);
      for (const secret of [EXAMPLE.shown, EXAMPLE.key, EXAMPLE.localProof, EXAMPLE.panelProof]) {
        assert.ok(!text.includes(secret));
      }
    } finally {
      methods.forEach((name, i) => (console[name] = saved[i]));
    }
    assert.deepEqual(written, []);
  });
});

/** Wait until a condition holds, checking every 5 ms for up to 2 seconds. */
async function waitFor(condition) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
