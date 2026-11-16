/**
 * tests/integration/fake-panel.js: a side panel as the control channel
 * specification describes its side (docs/api/control-channel.md): it dials
 * the local process on the loopback literal with an extension Origin, greets
 * it with a nonce, checks the local proof, answers with its own proof, and
 * then answers commands with result frames.
 *
 * It computes the proofs itself with node:crypto rather than through the
 * module under test, so the two sides are held to the specification
 * independently.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import { createHmac } from 'node:crypto';
import net from 'node:net';
import { setTimeout } from 'node:timers';
import WebSocket from 'ws';

/** The published extension's id, whose Origin the client accepts by default. */
export const STORE_EXTENSION_ID = 'odhpdgpoknpaakjdkdbjdgpljmpblijh';

/** The Origin the browser states for the published extension's panel. */
export const STORE_ORIGIN = `chrome-extension://${STORE_EXTENSION_ID}`;

/** The specification's worked example (control-channel LC-4). */
export const EXAMPLE = Object.freeze({
  shown: '7K3M-Q9XZ-4HTR-WB2N',
  key: '7K3MQ9XZ4HTRWB2N',
  panelNonce: '000102030405060708090a0b0c0d0e0f',
  localProof: 'f7fa184f820aad37881d3c7050b7808799e6211b3b75f96e9ad28fe0dbf7538a',
  localNonce: '0f0e0d0c0b0a09080706050403020100',
  panelProof: '0269c0d2e863e07f8a9d5b49f5dc1e4202251c885577e12e8687cdc82a58fcfb',
});

/**
 * HMAC-SHA256 keyed by the code over a direction's label and a nonce.
 *
 * @param {string} code
 * @param {string} label - `local:` or `panel:`
 * @param {string} nonce
 * @returns {string}
 */
export function proof(code, label, nonce) {
  return createHmac('sha256', code).update(`${label}${nonce}`).digest('hex');
}

/**
 * A free TCP port on the loopback literal, as the operating system hands one
 * out. It is released before it is returned, so a test binds it next.
 *
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Whether a TCP connection to the address is accepted.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function accepts(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Open one WebSocket to the local process, the way the panel dials: to the
 * loopback literal, again and again until something answers, here every 20 ms.
 * Resolves with the open connection, or with the HTTP status the local
 * process refused the handshake with.
 *
 * @param {number} port
 * @param {{origin?: string|null, deadlineMs?: number}} [options] - `origin`
 *   null sends no Origin header
 * @returns {Promise<{refused: number} | Peer>}
 */
export function dial(port, { origin = STORE_ORIGIN, deadlineMs = 3000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const options = origin === null ? {} : { origin };
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, options);
      const peer = wrap(socket);
      socket.once('open', () => resolve(peer));
      socket.once('unexpected-response', (request, response) => {
        resolve({ refused: response.statusCode });
        request.destroy();
      });
      socket.once('error', (error) => {
        if (socket.readyState === WebSocket.OPEN) return;
        if (error.code === 'ECONNREFUSED' && Date.now() < deadline) setTimeout(attempt, 20);
        else if (error.code === 'ECONNREFUSED') reject(new Error('Nothing answered on the port'));
      });
    };
    attempt();
  });
}

/**
 * @typedef {object} Peer
 * @property {WebSocket} socket
 * @property {() => Promise<object|{closed: number}>} next - the next frame the
 *   local process sent, parsed, or `{ closed }` with the close code once the
 *   connection has ended
 * @property {(frame: object|string|Buffer, options?: object) => void} send
 * @property {Promise<number>} closed - the close code
 */

/** Queue a socket's frames so a test reads them one at a time. */
function wrap(socket) {
  const frames = [];
  const waiters = [];
  let closeCode = null;
  const closed = new Promise((resolve) => {
    socket.once('close', (code) => {
      closeCode = code;
      for (const waiter of waiters.splice(0)) waiter({ closed: code });
      resolve(code);
    });
  });
  socket.on('error', () => {});
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    socket,
    closed,
    next: () => {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      if (closeCode !== null) return Promise.resolve({ closed: closeCode });
      return new Promise((resolve) => waiters.push(resolve));
    },
    send: (frame, options) =>
      socket.send(
        typeof frame === 'string' || Buffer.isBuffer(frame) ? frame : JSON.stringify(frame),
        options,
      ),
  };
}

/**
 * Play the panel's side of the pairing: greet, read the `pair` frame, check
 * the local proof, and answer with the panel's proof (or a wrong one).
 *
 * @param {Peer} peer
 * @param {{code?: string, nonce?: string, answer?: 'right'|'wrong'}} [options]
 * @returns {Promise<{pair: object, localProofValid: boolean}>}
 */
export async function pairAsPanel(
  peer,
  { code = EXAMPLE.key, nonce = EXAMPLE.panelNonce, answer = 'right' } = {},
) {
  peer.send({ type: 'hello', docent_control: 1, nonce });
  const pair = await peer.next();
  const localProofValid = pair.proof === proof(code, 'local:', nonce);
  if (!localProofValid) {
    peer.socket.close();
    return { pair, localProofValid };
  }
  const panelProof =
    answer === 'right'
      ? proof(code, 'panel:', pair.nonce)
      : proof('0000000000000000', 'panel:', pair.nonce);
  peer.send({ type: 'paired', proof: panelProof });
  return { pair, localProofValid };
}

/**
 * Answer every command frame the local process sends, through `handle`, which
 * returns the result's fields beyond the envelope (or null to leave the
 * command unanswered). Records the frames it read.
 *
 * @param {Peer} peer
 * @param {(frame: object) => object|null} handle
 * @returns {{frames: object[]}}
 */
export function serveAsPanel(peer, handle) {
  const frames = [];
  const loop = async () => {
    for (;;) {
      const frame = await peer.next();
      if ('closed' in frame) return;
      frames.push(frame);
      const fields = handle(frame);
      if (fields !== null) peer.send({ type: 'result', id: frame.id, ...fields });
    }
  };
  loop();
  return { frames };
}
