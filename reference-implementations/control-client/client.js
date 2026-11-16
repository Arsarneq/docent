/**
 * client.js: the local process side of the local control channel
 * (docs/api/control-channel.md), as a module another local program builds on.
 *
 * The panel is the WebSocket client and the local process the server
 * (control-channel overview). This module listens on 127.0.0.1 alone, on one
 * port (LC-3), and only while a pairing is awaited: from `pair()` until one
 * panel has paired or the attempt has ended. It accepts one connection, whose
 * Origin is exactly the configured extension's. It proves the pairing code
 * over the panel's nonce, checks the panel's proof over its own, and only then
 * sends commands and matches each result to its command by id (LC-4, LC-5,
 * LC-9).
 *
 * It returns each result as the panel sent it and interprets none of it.
 * Every outcome the channel can end in is returned as a value, never thrown:
 * `{ ok: false, code, message }`, the code one of FAILURES' keys and the
 * message that key's fixed text, followed by COMMANDS_MAY_HAVE_RUN when a
 * paired client ended with commands waiting. Nothing here logs, and no value it returns
 * carries the pairing code or a proof.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import http from 'node:http';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { WebSocketServer, WebSocket } from 'ws';

import { normalizePairingCode, generateNonce, computeProof, verifyPanelProof } from './pairing.js';
import {
  parsePanelFrame,
  readHello,
  readPaired,
  readResult,
  buildPairFrame,
  buildCommandFrame,
} from './frames.js';

/** The one address the panel dials, and so the one this module listens on. */
const LOOPBACK = '127.0.0.1';

/** The published extension's id: its Origin is the one accepted by default. */
export const DEFAULT_EXTENSION_ID = 'odhpdgpoknpaakjdkdbjdgpljmpblijh';

/** The port the side panel's turn-on control offers by default. */
export const DEFAULT_PORT = 8765;

/**
 * How long a pairing is awaited: the span over which the panel goes on
 * dialing an unanswered port, 150 dials 2 seconds apart (control-channel LC-3).
 */
export const DEFAULT_PAIR_TIMEOUT_MS = 300000;

/**
 * How long an accepted connection has to greet before it is dropped, so a
 * connection that says nothing cannot hold the one place for the whole
 * window. Ten seconds, the time the panel gives its own peer to pair (LC-5).
 */
export const DEFAULT_GREETING_TIMEOUT_MS = 10000;

/**
 * The largest frame this module reads from the panel, in bytes. The
 * specification bounds no frame the panel sends (LC-6), an export result
 * included; this bound is the local process's own, against a peer that sends
 * without end.
 */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * The most a peer may send before its proof checks out, in bytes: the cap on
 * frames the panel receives (LC-6), far above what the greeting and the
 * panel's proof take.
 */
const PAIRING_MAX_BYTES = 16384;

/** Lowest and highest port the panel dials (control-channel LC-3). */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** The form of a Chrome extension id: 32 letters from a to p. */
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * The sentence added, in one place, to the failure that ends a paired client
 * while commands are waiting: the panel finishes a command under way and
 * sends no result once its channel is off (control-channel LC-9).
 */
export const COMMANDS_MAY_HAVE_RUN =
  'A command still waiting may have run in the panel: after pairing again, read status rather than repeating it.';

/**
 * Every way an operation can fail, each with its fixed text. The texts carry
 * no value from the exchange, so none of them can carry the code or a proof.
 */
export const FAILURES = Object.freeze({
  'invalid-code':
    'That is not a pairing code: a code is 16 characters, shown in the side panel as four groups of four.',
  'pairing-already-attempted':
    'This client has already been asked to pair, and a client pairs once: create a new client to pair again. If the side panel shows Local control as off, turn it on again and use the new code.',
  'port-in-use': 'Another process holds the configured port on 127.0.0.1.',
  'listen-failed': 'Could not listen on the configured port on 127.0.0.1.',
  'pairing-timeout': 'No panel paired in time.',
  'unsupported-version':
    'A peer greeted with another version of the control channel protocol, and no panel speaking this version paired in time.',
  'random-source-failed':
    'The random source did not give the 16 bytes a nonce needs, so no pairing was attempted. If the side panel shows Local control as off, turn it on again and use the new code.',
  'pairing-refused':
    'The peer closed the connection after the pairing attempt without confirming it. A panel does so when the code is wrong, and turns Local control off; turning it on again shows a new code.',
  'panel-proof-mismatch':
    'The peer could not prove that it holds the pairing code, so the connection was closed. Turn Local control off in the side panel, which discards the code.',
  'protocol-error':
    'The peer sent a frame the control channel specification does not allow, so the connection was closed.',
  'frame-too-large-received':
    'The peer sent more than this client reads, so the connection was closed.',
  'not-paired': 'No panel is paired yet.',
  'invalid-command': 'The command could not be written as a command frame.',
  'frame-too-large':
    'The command frame is longer than the panel reads: 16384 UTF-16 code units at most.',
  disconnected: 'The connection to the panel ended, which turns Local control off in the panel.',
  closed: 'The control client was closed.',
});

/** Build the failure value for a code. */
function failure(code) {
  return { ok: false, code, message: FAILURES[code] };
}

/** The WebSocket close code sent for each way the client ends a connection. */
function closeCodeFor(code) {
  // `unsupported-version` ends the window, never the connection that greeted
  // with another version, which was closed when it was dropped; the
  // connection open at the window's end, if any, did nothing wrong.
  if (code === 'protocol-error') return 1002;
  if (code === 'panel-proof-mismatch') return 1008;
  return 1000;
}

/** Refuse a WebSocket handshake with an HTTP status, and drop the socket. */
function refuseHandshake(socket, status) {
  socket.on('error', () => {});
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

const OPTION_NAMES = new Set([
  'port',
  'extensionId',
  'pairTimeoutMs',
  'maxFrameBytes',
  'greetingTimeoutMs',
  'randomBytes',
]);

/** Check the options; a wrong one is a programming error and throws. */
function readOptions(options) {
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) throw new TypeError(`Unknown option: ${name}`);
  }
  const {
    port = DEFAULT_PORT,
    extensionId = DEFAULT_EXTENSION_ID,
    pairTimeoutMs = DEFAULT_PAIR_TIMEOUT_MS,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    greetingTimeoutMs = DEFAULT_GREETING_TIMEOUT_MS,
    randomBytes = cryptoRandomBytes,
  } = options;
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new RangeError(`port must be a whole number from ${MIN_PORT} to ${MAX_PORT}`);
  }
  if (typeof extensionId !== 'string' || !EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new TypeError('extensionId must be a Chrome extension id: 32 letters from a to p');
  }
  if (!Number.isInteger(pairTimeoutMs) || pairTimeoutMs < 1) {
    throw new RangeError('pairTimeoutMs must be a positive whole number');
  }
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < PAIRING_MAX_BYTES) {
    throw new RangeError(`maxFrameBytes must be a whole number of at least ${PAIRING_MAX_BYTES}`);
  }
  if (!Number.isInteger(greetingTimeoutMs) || greetingTimeoutMs < 1) {
    throw new RangeError('greetingTimeoutMs must be a positive whole number');
  }
  if (typeof randomBytes !== 'function') throw new TypeError('randomBytes must be a function');
  return { port, extensionId, pairTimeoutMs, maxFrameBytes, greetingTimeoutMs, randomBytes };
}

/**
 * Create a control client. It opens nothing until `pair()` is called.
 *
 * @param {object} [options]
 * @param {number} [options.port] - the port the person gave the panel,
 *   1024 to 65535; DEFAULT_PORT when left out
 * @param {string} [options.extensionId] - the id of the extension whose
 *   Origin (`chrome-extension://<id>`) is accepted; the published extension's
 *   when left out, and a build loaded from source states its own
 * @param {number} [options.pairTimeoutMs] - how long `pair()` waits for a
 *   panel to connect and complete the pairing
 * @param {number} [options.maxFrameBytes] - the largest frame read from the
 *   peer, from the first frame on; a larger one closes the connection. At
 *   least 16384, since before the panel's proof checks out the tighter bound
 *   of 16384 bytes in all applies beside it
 * @param {number} [options.greetingTimeoutMs] - how long an accepted
 *   connection has to greet before it is dropped
 * @param {(size: number) => Uint8Array} [options.randomBytes] - the random
 *   source of the local nonce; node:crypto's unless a test supplies its own
 * @returns {ControlClient}
 */
export function createControlClient(options = {}) {
  const { port, extensionId, pairTimeoutMs, maxFrameBytes, greetingTimeoutMs, randomBytes } =
    readOptions(options);
  const expectedOrigin = `chrome-extension://${extensionId}`;

  let state = 'idle';
  let attempted = false;
  let server = null;
  let socket = null;
  let pairTimer = null;
  let settlePairing = null;
  let lastId = 0;
  let endedWith = null;
  // Whether a dropped connection greeted with another protocol version, which
  // the window's end then reports in place of a plain timeout.
  let sawOtherVersion = false;
  // Commands awaiting their result, by id, in the order they were sent.
  const waiting = new Map();
  let socketGone = Promise.resolve();
  let announceEnd;
  const closed = new Promise((resolve) => {
    announceEnd = resolve;
  });

  function stopListening() {
    if (server === null) return;
    server.close();
    // A connection accepted but never upgraded would otherwise outlive the
    // client; the paired connection is no longer the HTTP server's and stays.
    server.closeAllConnections();
    server = null;
  }

  // Every route by which the client ends goes through here, once.
  function end(code) {
    if (state === 'closed') return;
    const outcome = failure(code);
    // Commands still waiting on a paired client may have run (LC-9); the
    // failure that ends it says so, here and nowhere else.
    if (state === 'paired' && waiting.size > 0) {
      outcome.message = `${outcome.message} ${COMMANDS_MAY_HAVE_RUN}`;
    }
    state = 'closed';
    endedWith = outcome;
    if (pairTimer !== null) clearTimeout(pairTimer);
    pairTimer = null;
    stopListening();
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.close(closeCodeFor(code));
      // A peer that does not answer the close is dropped rather than waited on.
      const stuck = socket;
      setTimeout(() => stuck.terminate(), 2000).unref();
    }
    if (settlePairing !== null) settlePairing({ ...outcome });
    settlePairing = null;
    for (const resolve of waiting.values()) resolve({ ...outcome });
    waiting.clear();
    announceEnd({ ...outcome });
  }

  // One accepted connection. Until the client has sent its `pair` frame,
  // nothing has been attempted (LC-5): a connection that ends, misbehaves or
  // stays silent past the greeting deadline is dropped, and the client goes on
  // listening for the rest of the window. From the `pair` frame on, the
  // connection is the attempt, and whatever ends it ends the client.
  function accept(ws, rawSocket, code) {
    socket = ws;
    socketGone = new Promise((resolve) => ws.once('close', resolve));
    let pairingCode = code;
    let phase = 'hello';
    let localNonce = null;
    let dropped = false;
    let received = 0;

    // Drop this connection and go on listening. A peer greeting with another
    // protocol version is closed with a protocol error, as LC-4 has a local
    // process close it; any other is cut off.
    function drop(closeCode = null) {
      if (dropped) return;
      dropped = true;
      clearTimeout(greetingTimer);
      rawSocket.off('data', countBytes);
      if (socket === ws) socket = null;
      if (closeCode === null || ws.readyState !== WebSocket.OPEN) {
        ws.terminate();
        return;
      }
      ws.close(closeCode);
      setTimeout(() => ws.terminate(), 2000).unref();
    }

    function overflow() {
      if (phase === 'hello') drop();
      else end('frame-too-large-received');
    }

    // Until the panel's proof checks out, what the peer may send is bounded by
    // what the pairing needs; the larger bound applies once paired. Counted
    // ahead of the WebSocket's own reading, so no more than one read is held.
    function countBytes(chunk) {
      received += chunk.length;
      if (received > PAIRING_MAX_BYTES) overflow();
    }
    rawSocket.prependListener('data', countBytes);
    const greetingTimer = setTimeout(drop, greetingTimeoutMs);

    ws.on('error', (error) => {
      if (dropped) return;
      if (phase === 'hello') {
        drop();
        return;
      }
      end(
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? 'frame-too-large-received'
          : 'protocol-error',
      );
    });
    ws.on('close', () => {
      if (dropped) return;
      if (phase === 'hello') {
        drop();
        return;
      }
      end(phase === 'commands' ? 'disconnected' : 'pairing-refused');
    });
    ws.on('message', (data, isBinary) => {
      if (dropped || state === 'closed') return;
      if (phase !== 'commands' && data.length > PAIRING_MAX_BYTES) {
        overflow();
        return;
      }
      const parsed = parsePanelFrame(data, isBinary);

      if (phase === 'hello') {
        const hello = parsed.ok ? readHello(parsed.message) : { ok: false };
        if (!hello.ok) {
          if (hello.code === 'unsupported-version') {
            sawOtherVersion = true;
            drop(1002);
            return;
          }
          drop();
          return;
        }
        localNonce = generateNonce(randomBytes);
        if (localNonce === null) {
          end('random-source-failed');
          return;
        }
        clearTimeout(greetingTimer);
        phase = 'paired';
        ws.send(
          buildPairFrame({
            proof: computeProof(pairingCode, hello.nonce, 'local'),
            nonce: localNonce,
          }),
        );
        return;
      }

      if (!parsed.ok) {
        end('protocol-error');
        return;
      }
      const message = parsed.message;

      if (phase === 'paired') {
        const paired = readPaired(message);
        if (!paired.ok) {
          end('protocol-error');
          return;
        }
        const proven = verifyPanelProof({
          code: pairingCode,
          nonce: localNonce,
          proof: paired.proof,
        });
        pairingCode = null;
        if (!proven) {
          end('panel-proof-mismatch');
          return;
        }
        rawSocket.off('data', countBytes);
        phase = 'commands';
        state = 'paired';
        clearTimeout(pairTimer);
        pairTimer = null;
        stopListening();
        settlePairing({ ok: true });
        settlePairing = null;
        return;
      }

      const result = readResult(message);
      if (!result.ok) {
        end('protocol-error');
        return;
      }
      // The panel answers in the order commands arrive (LC-9), so a result
      // whose id it could not read answers the oldest command still waiting.
      const id = result.id === null ? waiting.keys().next().value : result.id;
      const resolve = id === undefined ? undefined : waiting.get(id);
      if (resolve === undefined) {
        end('protocol-error');
        return;
      }
      waiting.delete(id);
      resolve({ ok: true, result: message });
    });
  }

  function listen(code) {
    server = http.createServer((request, response) => {
      response.writeHead(426, { Connection: 'close', 'Content-Length': '0' });
      response.end();
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: maxFrameBytes,
      perMessageDeflate: false,
    });
    server.on('upgrade', (request, rawSocket, head) => {
      if (state !== 'listening') return refuseHandshake(rawSocket, 503);
      if (request.headers.origin !== expectedOrigin) return refuseHandshake(rawSocket, 403);
      if (socket !== null) return refuseHandshake(rawSocket, 409);
      // The upgrade completes, or is refused, before handleUpgrade returns, so
      // a second handshake always finds `socket` set.
      wss.handleUpgrade(request, rawSocket, head, (ws) => accept(ws, rawSocket, code));
    });
    server.on('error', (error) =>
      end(error.code === 'EADDRINUSE' ? 'port-in-use' : 'listen-failed'),
    );
    // The address and port are held by this process alone (LC-3): `exclusive`
    // keeps the handle from being shared with cluster workers, and no
    // port-sharing option is set, so another process's bind of the port, on
    // the loopback literal or the wildcard, is refused while it is held. The
    // integration suite pins that refusal on the platform it runs on.
    server.listen({ port, host: LOOPBACK, exclusive: true });
  }

  return {
    /**
     * Pair with the panel, using the code a person typed. The code's shape is
     * checked before anything opens; a code of the wrong shape leaves the
     * attempt unspent. Then the client listens, accepts the panel, and
     * proves the code in both directions.
     *
     * @param {string} typed - the code as typed, with or without its hyphens
     * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
     */
    pair(typed) {
      if (attempted) return Promise.resolve(failure('pairing-already-attempted'));
      if (state === 'closed') return Promise.resolve(failure('closed'));
      const normalized = normalizePairingCode(typed);
      if (!normalized.ok) return Promise.resolve(failure('invalid-code'));
      attempted = true;
      state = 'listening';
      return new Promise((resolve) => {
        settlePairing = resolve;
        pairTimer = setTimeout(
          () => end(sawOtherVersion ? 'unsupported-version' : 'pairing-timeout'),
          pairTimeoutMs,
        );
        listen(normalized.code);
      });
    },

    /**
     * Send one command and wait for its result. Commands may be sent behind
     * one another; each result is matched to its command by id.
     *
     * @param {string} command - the command's name, sent as given
     * @param {object} [args] - its arguments; left out, the frame carries none
     * @returns {Promise<{ok: true, result: object} |
     *   {ok: false, code: string, message: string}>} `result` is the result
     *   frame as the panel sent it, its own `ok` included
     */
    send(command, args) {
      if (state === 'closed') return Promise.resolve({ ...endedWith });
      if (state !== 'paired') return Promise.resolve(failure('not-paired'));
      lastId += 1;
      const id = String(lastId);
      const frame = buildCommandFrame({ id, command, args });
      if (!frame.ok) return Promise.resolve(failure(frame.code));
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        socket.send(frame.text);
      });
    },

    /**
     * Close the client: stop listening, close the connection, and end every
     * operation still waiting with the `closed` failure. Resolves once the
     * connection has closed.
     *
     * @returns {Promise<void>}
     */
    async close() {
      end('closed');
      await socketGone;
    },

    /**
     * The address listened on while a pairing is awaited, and null otherwise.
     *
     * @returns {{address: string, port: number, family: string} | null}
     */
    address() {
      if (state !== 'listening' || server === null || !server.listening) return null;
      const { address, port: bound, family } = server.address();
      return { address, port: bound, family };
    },

    /** `idle`, `listening`, `paired` or `closed`. */
    get state() {
      return state;
    },

    /** Resolves, once the client has ended, with the failure that ended it. */
    get closed() {
      return closed;
    },
  };
}

/**
 * @typedef {object} ControlClient
 * @property {(typed: string) => Promise<object>} pair
 * @property {(command: string, args?: object) => Promise<object>} send
 * @property {() => Promise<void>} close
 * @property {() => ({address: string, port: number, family: string} | null)} address
 * @property {string} state
 * @property {Promise<{ok: false, code: string, message: string}>} closed
 */
