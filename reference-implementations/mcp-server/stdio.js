/**
 * stdio.js: the stdio transport of the Model Context Protocol, as a server
 * sees it: one JSON-RPC message per line on the input, and one per line on
 * the output, with nothing else written there.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

import readline from 'node:readline';

/**
 * Read the input line by line, hand each line to the handler, and write each
 * answer as one line. Lines are handled as they arrive, without waiting for
 * an earlier line's answer, so answers are written in the order they are
 * ready.
 *
 * @param {object} params
 * @param {import('node:stream').Readable} params.input
 * @param {import('node:stream').Writable} params.output
 * @param {(line: string) => Promise<object|null>} params.handleLine - answers
 *   a line with the message to write, or null for none
 * @param {() => void} [params.onInputEnd] - called once the input has ended,
 *   or failed,
 *   before the answers still under way are awaited
 * @returns {Promise<void>} resolves once the input has ended and every answer
 *   has been written
 */
export function serveLines({ input, output, handleLine, onInputEnd }) {
  const underWay = new Set();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const answering = Promise.resolve()
      .then(() => handleLine(line))
      .then(
        (message) => {
          // JSON.stringify writes a newline inside text as an escape, so a
          // message is always one line.
          if (message !== null) output.write(`${JSON.stringify(message)}\n`);
        },
        () => {},
      )
      .finally(() => underWay.delete(answering));
    underWay.add(answering);
  });

  // An input that fails has ended: nothing further can be read from it.
  lines.on('error', () => lines.close());
  input.on('error', () => lines.close());

  return new Promise((resolve) => {
    lines.once('close', async () => {
      if (onInputEnd !== undefined) onInputEnd();
      while (underWay.size > 0) await Promise.all(underWay);
      resolve();
    });
  });
}
