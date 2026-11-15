/**
 * control-channel.js — Pure core of the local control channel.
 *
 * The side panel can open one outward WebSocket to a process on the same
 * machine, through which that process issues a closed set of the panel's own
 * actions. This module holds every decision of that channel that needs no
 * platform: which address may be dialled, how a pairing code is made and proven
 * in both directions, which frames and commands are well-formed, and the
 * session that refuses everything until the peer has proven it holds the code.
 *
 * Kept free of the panel's DOM and of chrome.* for unit testability (the
 * pure-logic discipline lib/frame-trust.js names): plain data in
 * and out, with the socket, the clock and the command executor injected. The
 * only platform surface it touches is Web Crypto, present under the same name
 * in an extension page and in the unit suite's runtime. The side panel owns
 * the socket, the on/off switch and the mapping from a command to the panel
 * action that carries it out.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/** Version of the wire protocol, sent in the greeting. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** The one host the channel dials: the IPv4 loopback literal, never a name. */
export const CONTROL_HOST = '127.0.0.1';

/** Lowest and highest port the channel dials — the unprivileged range. */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/**
 * Largest frame, in UTF-16 code units, the channel reads. It bounds received
 * frames only: a result the panel sends is one frame whatever its length
 * (control-channel LC-6).
 */
export const MAX_FRAME_CHARS = 16384;

/** Longest project or recording name a command may carry. */
export const MAX_NAME_CHARS = 200;

/** Longest narration a command may carry. */
export const MAX_NARRATION_CHARS = 10000;

/** Longest command id echoed back in a result. */
export const MAX_ID_CHARS = 64;

/** How long the peer has to prove the code before the session closes. */
export const PAIR_TIMEOUT_MS = 10000;

/**
 * Characters in a pairing code: sixteen of five bits each, 80 bits, so a proof
 * seen on the wire does not let anyone find the code by trying codes
 * (control-channel LC-4).
 */
export const PAIRING_CODE_LENGTH = 16;

/** Characters per group when a code is shown. */
const CODE_GROUP_LENGTH = 4;

// Crockford's base-32 alphabet: no I, L, O or U, so a code read from the
// screen and typed elsewhere has no look-alike characters. Thirty-two symbols
// make each character five bits, taken from a random byte without bias.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A Set whose membership is fixed at construction: the mutators throw, so the
 * command set below cannot be widened in place by code that imports it.
 */
class ClosedSet extends Set {
  constructor(values) {
    super();
    for (const value of values) super.add(value);
  }
  add() {
    throw new TypeError('This set is closed');
  }
  delete() {
    throw new TypeError('This set is closed');
  }
  clear() {
    throw new TypeError('This set is closed');
  }
}

/**
 * The closed command set: the panel's structuring actions, one read, and the
 * export a person allows at turn-on (control-channel LC-7). Deleting,
 * renaming, importing, sending, syncing and settings are not on it.
 */
export const CONTROL_COMMANDS = new ClosedSet([
  'status',
  'project.create',
  'recording.create',
  'recording.pause',
  'recording.resume',
  'step.commit',
  'project.export',
]);

// ─── Address ──────────────────────────────────────────────────────────────────

/**
 * Build the URL the channel dials for a port. The host is fixed; the port is
 * the only input, and it must be a plain decimal integer in the unprivileged
 * range — so no caller-supplied text can steer the connection to another host,
 * path or scheme.
 *
 * @param {number|string} port
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function controlUrl(port) {
  let value = null;
  if (typeof port === 'number') value = port;
  else if (typeof port === 'string' && /^[0-9]{1,5}$/.test(port)) value = Number(port);
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    return { ok: false, error: `Port must be a whole number from ${MIN_PORT} to ${MAX_PORT}` };
  }
  return { ok: true, url: `ws://${CONTROL_HOST}:${value}` };
}

// ─── Pairing code and nonce ───────────────────────────────────────────────────

/**
 * Generate a one-time pairing code.
 *
 * @param {(bytes: Uint8Array) => unknown} fillRandom - fills the array with
 *   cryptographically strong random bytes (crypto.getRandomValues in the panel)
 * @returns {string} PAIRING_CODE_LENGTH characters of the code alphabet
 */
export function generatePairingCode(fillRandom) {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  fillRandom(bytes);
  let code = '';
  for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
  return code;
}

/**
 * Format a pairing code for display, in groups of four separated by hyphens.
 * The hyphens are display only and are not part of the code.
 *
 * @param {string} code
 * @returns {string}
 */
export function formatPairingCode(code) {
  const groups = [];
  for (let i = 0; i < code.length; i += CODE_GROUP_LENGTH) {
    groups.push(code.slice(i, i + CODE_GROUP_LENGTH));
  }
  return groups.join('-');
}

/**
 * The indicator's line on the export grant and each export made under it
 * (control-channel LC-2): empty without the grant, the grant alone before the
 * first export, then the project last exported and the running count.
 *
 * @param {{exportAllowed: boolean, exports: number, lastExport: string|null}} status
 * @returns {string}
 */
export function describeExportGrant(status) {
  if (!status.exportAllowed) return '';
  const allowed = 'Export is allowed for the project open here.';
  if (status.exports === 0) return allowed;
  const count = status.exports === 1 ? '1 export' : `${status.exports} exports`;
  return `${allowed} Exported "${status.lastExport}" (${count} so far).`;
}

/** The form of a nonce, the panel's and the local process's alike. */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Generate the per-connection nonce the peer's proof is bound to.
 *
 * @param {(bytes: Uint8Array) => unknown} fillRandom
 * @returns {string} 32 lowercase hex characters
 */
export function generateNonce(fillRandom) {
  const bytes = new Uint8Array(16);
  fillRandom(bytes);
  return toHex(bytes);
}

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// ─── Pair proof ───────────────────────────────────────────────────────────────

/**
 * The label each direction's proof is computed over, ahead of the nonce, so a
 * proof made for one direction is never the proof of the other
 * (control-channel LC-4).
 */
export const PROOF_LABELS = Object.freeze({ local: 'local:', panel: 'panel:' });

/**
 * HMAC-SHA256 of a message keyed by a key, both as UTF-8, in lowercase hex.
 *
 * @param {string} key
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Hex(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return toHex(new Uint8Array(mac));
}

/**
 * Compute a holder of the pairing code's proof in one direction: HMAC-SHA256
 * keyed by the code over the direction's label and the other side's nonce.
 * The local process proves over the panel's nonce (`local`), the panel over
 * the local process's (`panel`). The code itself never crosses the
 * connection, and a proof is good for one nonce and one direction only.
 *
 * @param {string} code - the pairing code as generated (no separators)
 * @param {string} nonce - the other side's nonce
 * @param {'local'|'panel'} side - whose proof this is
 * @returns {Promise<string>}
 */
export async function computePairProof(code, nonce, side) {
  if (!Object.hasOwn(PROOF_LABELS, side)) throw new TypeError('Unknown proof direction');
  return hmacSha256Hex(code, `${PROOF_LABELS[side]}${nonce}`);
}

/**
 * Check the local process's proof against the code and this connection's
 * nonce. The
 * comparison reads every character whatever the first difference, so the time
 * it takes says nothing about how much of a guess was right.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.nonce
 * @param {unknown} params.proof - the value the peer sent
 * @returns {Promise<boolean>}
 */
export async function verifyPairProof({ code, nonce, proof }) {
  if (typeof proof !== 'string') return false;
  const expected = await computePairProof(code, nonce, 'local');
  if (proof.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  }
  return difference === 0;
}

// ─── Frames ───────────────────────────────────────────────────────────────────

/**
 * Parse one received frame. Only a text frame within the size bound that holds
 * a JSON object is a message.
 *
 * @param {unknown} data - the WebSocket message event's data
 * @returns {{ok: true, message: object} | {ok: false, error: string}}
 */
export function parseFrame(data) {
  if (typeof data !== 'string') return { ok: false, error: 'Only text frames are accepted' };
  if (data.length > MAX_FRAME_CHARS) return { ok: false, error: 'Frame too large' };
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return { ok: false, error: 'Frame is not valid JSON' };
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, error: 'Frame is not a JSON object' };
  }
  return { ok: true, message };
}

/** True when `value` is a plain object whose own keys all sit in `allowed`. */
function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Validate a required, trimmed, bounded text argument. */
function readText(value, label, max) {
  if (typeof value !== 'string') return { error: `${label} must be text` };
  const text = value.trim();
  if (text.length === 0) return { error: `${label} must not be empty` };
  if (text.length > max) return { error: `${label} must be at most ${max} characters` };
  return { text };
}

/** Validate the arguments of a command that carries a single name. */
function readNameArgs(args) {
  if (!hasOnlyKeys(args, ['name'])) return { error: 'Unknown argument' };
  const name = readText(args.name, 'name', MAX_NAME_CHARS);
  return name.error ? name : { args: { name: name.text } };
}

/** Validate the arguments of a command that carries none. */
function readNoArgs(args) {
  return Object.keys(args).length === 0
    ? { args: {} }
    : { error: 'This command takes no arguments' };
}

/**
 * Validate a step commit: either a narration (the panel's narration mode) or a
 * step type with, for a validation, what it expects (the panel's simple mode).
 */
function readCommitArgs(args) {
  if (!hasOnlyKeys(args, ['narration', 'step_type', 'expect']))
    return { error: 'Unknown argument' };
  const hasNarration = 'narration' in args;
  const hasType = 'step_type' in args;
  if (hasNarration === hasType) {
    return { error: 'A step commit carries either narration or step_type' };
  }
  if (hasNarration) {
    if ('expect' in args) return { error: 'expect belongs to a validation step' };
    const narration = readText(args.narration, 'narration', MAX_NARRATION_CHARS);
    return narration.error ? narration : { args: { narration: narration.text } };
  }
  if (args.step_type === 'action') {
    if ('expect' in args) return { error: 'expect belongs to a validation step' };
    return { args: { step_type: 'action' } };
  }
  if (args.step_type === 'validation') {
    const expect = 'expect' in args ? args.expect : 'present';
    if (expect !== 'present' && expect !== 'absent') {
      return { error: 'expect must be "present" or "absent"' };
    }
    return { args: { step_type: 'validation', expect } };
  }
  return { error: 'step_type must be "action" or "validation"' };
}

// One argument reader per command of the closed set. A Map, so a command name
// is looked up among these entries alone and never on an object's prototype.
const ARGUMENT_READERS = new Map([
  ['status', readNoArgs],
  ['project.create', readNameArgs],
  ['recording.create', readNameArgs],
  ['recording.pause', readNoArgs],
  ['recording.resume', readNoArgs],
  ['step.commit', readCommitArgs],
  ['project.export', readNoArgs],
]);

/**
 * Validate a parsed message as a command of the closed set.
 *
 * @param {object} message - a parsed frame
 * @returns {{ok: true, command: {id: string, name: string, args: object}} |
 *   {ok: false, id: string|null, error: string}} on refusal `id` is the
 *   message's id when it was usable, so the answer can be matched to the
 *   request, and null otherwise
 */
export function validateCommand(message) {
  const idUsable =
    typeof message.id === 'string' && message.id.length > 0 && message.id.length <= MAX_ID_CHARS;
  const refuse = (error) => ({ ok: false, id: idUsable ? message.id : null, error });

  if (message.type !== 'command') return refuse('Expected a command');
  if (!idUsable) return refuse(`id must be text of 1 to ${MAX_ID_CHARS} characters`);
  if (!hasOnlyKeys(message, ['type', 'id', 'command', 'args'])) return refuse('Unknown field');
  if (typeof message.command !== 'string' || !CONTROL_COMMANDS.has(message.command)) {
    return refuse('Unknown command');
  }
  const args = message.args === undefined ? {} : message.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return refuse('args must be an object');
  }
  const read = ARGUMENT_READERS.get(message.command)(args);
  if (read.error) return refuse(read.error);
  return { ok: true, command: { id: message.id, name: message.command, args: read.args } };
}

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * One connection's session. It greets the peer with a nonce, accepts exactly
 * one pairing attempt, and only once that proof checks out does it validate
 * and run commands — one at a time, in arrival order, each answered with a
 * result frame carrying the command's id.
 *
 * States: `idle` (created) → `awaiting-pair` (opened) → `paired` → `closed`.
 * Any failure before pairing closes the session; it never returns to
 * `awaiting-pair`, so a pairing code is good for one attempt.
 *
 * @param {object} params
 * @param {string} params.code - the pairing code this session accepts
 * @param {string} params.nonce - this connection's nonce
 * @param {(text: string) => void} params.send - sends a text frame
 * @param {(reason: string) => void} params.close - closes the connection; called
 *   once, with `pairing-failed`, `pairing-timeout` or the reason given to `end`
 * @param {(command: {id: string, name: string, args: object}) => Promise<object>}
 *   params.execute - carries out a validated command and resolves with
 *   `{ ok: true, … }` or `{ ok: false, error }`; its result is sent as one
 *   frame, however long
 * @param {(state: string) => void} [params.onState] - told when the session
 *   enters `awaiting-pair` and `paired`; its end is reported through `close`
 * @param {(fn: () => void, ms: number) => unknown} [params.setTimer]
 * @param {(handle: unknown) => void} [params.clearTimer]
 * @returns {{open: () => void, receive: (data: unknown) => Promise<void>,
 *   end: (reason: string) => void, readonly state: string}}
 */
export function createControlSession({
  code,
  nonce,
  send,
  close,
  execute,
  onState = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let state = 'idle';
  let pairTimer = null;
  let queue = Promise.resolve();

  function enter(next) {
    state = next;
    onState(next);
  }

  function end(reason) {
    if (state === 'closed') return;
    if (pairTimer !== null) clearTimer(pairTimer);
    pairTimer = null;
    state = 'closed';
    close(reason);
  }

  function sendMessage(message) {
    if (state !== 'closed') send(JSON.stringify(message));
  }

  function open() {
    if (state !== 'idle') return;
    enter('awaiting-pair');
    pairTimer = setTimer(() => end('pairing-timeout'), PAIR_TIMEOUT_MS);
    sendMessage({ type: 'hello', docent_control: CONTROL_PROTOCOL_VERSION, nonce });
  }

  // The first frame is the one attempt, whatever it holds: it either pairs the
  // session or closes it, so this never runs twice. Exactly three fields: the
  // peer's proof over this connection's nonce and the peer's own nonce, which
  // the panel proves the code over in return — only once the peer has proven
  // it, so a peer without the code gets nothing to test guesses against.
  async function receivePair(data) {
    const parsed = parseFrame(data);
    const message = parsed.ok ? parsed.message : null;
    const wellFormed =
      message !== null &&
      message.type === 'pair' &&
      hasOnlyKeys(message, ['type', 'proof', 'nonce']) &&
      typeof message.nonce === 'string' &&
      NONCE_PATTERN.test(message.nonce);
    const proven = wellFormed && (await verifyPairProof({ code, nonce, proof: message.proof }));
    const answer = proven ? await computePairProof(code, message.nonce, 'panel') : null;
    if (state !== 'awaiting-pair') return;
    if (!proven) {
      end('pairing-failed');
      return;
    }
    if (pairTimer !== null) clearTimer(pairTimer);
    pairTimer = null;
    enter('paired');
    sendMessage({ type: 'paired', proof: answer });
  }

  async function runCommand(data) {
    if (state !== 'paired') return;
    const parsed = parseFrame(data);
    if (!parsed.ok) {
      sendMessage({ type: 'result', id: null, ok: false, error: parsed.error });
      return;
    }
    const checked = validateCommand(parsed.message);
    if (!checked.ok) {
      sendMessage({ type: 'result', id: checked.id, ok: false, error: checked.error });
      return;
    }
    let outcome;
    try {
      outcome = await execute(checked.command);
    } catch {
      // A failure's own text could carry anything; the peer gets a fixed one.
      outcome = { ok: false, error: 'The command failed' };
    }
    // The envelope's own fields are written last, so a result cannot replace them.
    sendMessage({ ...outcome, type: 'result', id: checked.command.id, ok: outcome?.ok === true });
  }

  // Frames are dealt with one at a time, in arrival order. A command sent
  // right behind the proof therefore waits for the proof's verdict: it runs
  // once the session is paired and is dropped if the session closed instead.
  function receive(data) {
    if (state !== 'awaiting-pair' && state !== 'paired') return Promise.resolve();
    // An oversized message is refused when its turn comes; only enough of it
    // to be recognised as oversized is kept until then.
    const frame = typeof data === 'string' ? data.slice(0, MAX_FRAME_CHARS + 1) : data;
    queue = queue.then(() => {
      if (state === 'awaiting-pair') return receivePair(frame);
      return runCommand(frame);
    });
    return queue;
  }

  return {
    open,
    receive,
    end,
    get state() {
      return state;
    },
  };
}
