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

/**
 * Read the ephemeral CDP port Chrome bound for this profile.
 *
 * The wait is bounded, and expiry is its own error naming the directory —
 * never a hang and never a success-shaped fallback value.
 *
 * @param {string} userDataDir - The profile directory the browser launched with
 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<number>} The bound debug port
 */
export async function readDevToolsPort(userDataDir, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0].trim();
      const port = Number.parseInt(firstLine, 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Not written yet — keep polling until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `DevToolsActivePort did not appear under ${userDataDir} within ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
