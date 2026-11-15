/**
 * control-channel-host.js — The side panel's local control channel host.
 *
 * Owns the channel's on/off switch and its one outward socket. Turning the
 * channel on makes a fresh pairing code and dials the loopback address on the
 * chosen port; the session from control-channel.js then decides what the
 * peer may do. Everything here lives in the panel page's memory and nowhere
 * else: closing the panel ends the page, the socket and the code together, and
 * nothing about the channel is written to storage.
 *
 * The socket constructor, the random source, the clock and the command
 * executor are injected, so the unit suite drives this module as shipped.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import {
  controlUrl,
  generatePairingCode,
  formatPairingCode,
  generateNonce,
  createControlSession,
} from './control-channel.js';

/** Pause between dial attempts while no local process answers. */
export const CONNECT_RETRY_MS = 2000;

/** How long one dial attempt may take to open before it counts as unanswered. */
export const CONNECT_TIMEOUT_MS = 10000;

/** Dial attempts before the channel gives up and turns itself off. */
export const MAX_CONNECT_ATTEMPTS = 150;

const NOTICES = {
  'pairing-failed': 'Pairing failed. Turn local control on again to get a new code.',
  'pairing-timeout':
    'The local process did not pair in time. Turn local control on again to get a new code.',
  disconnected: 'The local process disconnected. Local control is off.',
};

/**
 * Create the host.
 *
 * @param {object} params
 * @param {(url: string) => WebSocket} params.createSocket
 * @param {(bytes: Uint8Array) => unknown} params.fillRandom
 * @param {(command: {id: string, name: string, args: object}) => Promise<object>}
 *   params.execute - carries out a validated command as a panel action
 * @param {(status: object) => void} [params.onChange] - told every status change
 * @param {(fn: () => void, ms: number) => unknown} [params.setTimer]
 * @param {(handle: unknown) => void} [params.clearTimer]
 * @returns {{enable: (port: number|string) => {ok: boolean, error?: string},
 *   disable: () => void, readonly status: {state: string, port: number|null,
 *   code: string|null, notice: string|null}}} `state` is `off`, `connecting`,
 *   `awaiting-pair` or `paired`; `code` is the pairing code in display form
 *   until the peer has paired; `notice` says why the channel last turned itself
 *   off
 */
export function createControlChannelHost({
  createSocket,
  fillRandom,
  execute,
  onChange = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = 'off';
  let port = null;
  let url = null;
  let code = null;
  let notice = null;
  let attempts = 0;
  let retryTimer = null;
  // Bumped whenever the channel turns off, so a socket event or timer left over
  // from an earlier turn-on can tell it no longer speaks for the channel.
  let generation = 0;
  let socket = null;
  let session = null;

  function status() {
    return {
      state,
      port,
      code: code !== null && state !== 'paired' ? formatPairingCode(code) : null,
      notice,
    };
  }

  function publish() {
    onChange(status());
  }

  function turnOff(why) {
    if (state === 'off') return;
    generation++;
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
    const endedSession = session;
    const endedSocket = socket;
    session = null;
    socket = null;
    state = 'off';
    port = null;
    url = null;
    code = null;
    notice = why;
    endedSession?.end('disabled');
    endedSocket?.close();
    publish();
  }

  function dial() {
    const mine = generation;
    const current = () => mine === generation;
    let opened = false;
    attempts++;
    const ws = createSocket(url);
    socket = ws;
    const mySession = createControlSession({
      code,
      nonce: generateNonce(fillRandom),
      send: (text) => ws.send(text),
      // The session ends itself only for a pairing failure or timeout.
      close: (reason) => {
        if (current() && Object.hasOwn(NOTICES, reason)) turnOff(NOTICES[reason]);
      },
      execute,
      onState: (next) => {
        if (!current()) return;
        state = next;
        publish();
      },
      setTimer,
      clearTimer,
    });
    session = mySession;

    // A peer that accepts the connection but never completes the handshake
    // would otherwise hold this attempt open; closing it counts as no answer.
    const connectTimer = setTimer(() => {
      if (current() && !opened && socket === ws) ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (!current()) return;
      clearTimer(connectTimer);
      opened = true;
      mySession.open();
    };
    ws.onmessage = (event) => (current() ? mySession.receive(event.data) : undefined);
    ws.onclose = () => {
      clearTimer(connectTimer);
      if (!current()) return;
      if (opened) {
        // A connection that was made and then ended is the end of this turn-on,
        // paired or not: the code gets one attempt.
        turnOff(state === 'paired' ? NOTICES.disconnected : NOTICES['pairing-failed']);
        return;
      }
      // Nothing answered. Dial again with the same code until the cap.
      if (attempts >= MAX_CONNECT_ATTEMPTS) {
        turnOff(`No local process answered on port ${port}. Local control is off.`);
        return;
      }
      retryTimer = setTimer(() => {
        retryTimer = null;
        if (current()) dial();
      }, CONNECT_RETRY_MS);
    };
  }

  function enable(requestedPort) {
    if (state !== 'off') return { ok: false, error: 'Local control is already on' };
    const target = controlUrl(requestedPort);
    if (!target.ok) return { ok: false, error: target.error };
    url = target.url;
    port = Number(requestedPort);
    code = generatePairingCode(fillRandom);
    notice = null;
    attempts = 0;
    state = 'connecting';
    publish();
    dial();
    return { ok: true };
  }

  return {
    enable,
    disable: () => turnOff(null),
    get status() {
      return status();
    },
  };
}
