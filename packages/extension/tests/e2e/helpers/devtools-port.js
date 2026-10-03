/**
 * devtools-port.js — resolve the CDP debug port of a launched Chrome.
 *
 * The coverage specs launch Chrome with `--remote-debugging-port=0`, so the
 * OS assigns an ephemeral port and two simultaneous runs can never collide
 * on a fixed one. Chrome writes the port it actually bound to the
 * `DevToolsActivePort` file in the profile directory (first line: the port;
 * second: the browser target's WebSocket path). This helper polls for that
 * file after launch and returns the port for
 * `cdp-sw-coverage.js`'s HTTP target discovery.
 */

import fs from 'fs';
import path from 'path';
import { waitForState } from './deadline-poll.js';

/**
 * Read the ephemeral CDP port Chrome bound for this profile.
 *
 * The wait is bounded (`deadline-poll.js`), and expiry is its own error naming
 * the directory and the last value read — null while the file is not written,
 * the parsed first line otherwise, so an absent file, a zero port and an
 * unparsable line (NaN) each read as themselves — never a hang and never a
 * success-shaped fallback value.
 *
 * @param {string} userDataDir - The profile directory the browser launched with
 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<number>} The bound debug port
 */
export async function readDevToolsPort(userDataDir, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const readPort = () => {
    try {
      return Number.parseInt(fs.readFileSync(file, 'utf-8').split('\n')[0].trim(), 10);
    } catch {
      return null; // Not written yet — keep polling until the deadline.
    }
  };
  return waitForState(
    readPort,
    (port) => Number.isInteger(port) && port > 0,
    `DevToolsActivePort under ${userDataDir} within ${timeoutMs} ms`,
    { timeout: timeoutMs, interval: pollMs, format: String },
  );
}
