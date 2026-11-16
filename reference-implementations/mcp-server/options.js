/**
 * options.js: reading the server's command line. Plain data in and out: the
 * values are read as text and whole numbers here, and their ranges are
 * checked by the parts that own them (the control client its port, extension
 * id and wait; export-file.js the export folder).
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 */

/**
 * How long a `pair` call waits for the panel by default. The panel dials
 * every 2 seconds while the channel is on (control-channel LC-3), so a call
 * made after turn-on needs a few seconds; the control client's own default,
 * the whole span over which the panel dials, is longer than a caller of a
 * tool usually waits.
 */
export const DEFAULT_PAIR_TIMEOUT_MS = 30000;

/** The options' text, printed for `--help` and after a refused command line. */
export const USAGE = `Usage: node server.js [options]

  --port <n>              The port the person gave the side panel (default 8765)
  --extension-id <id>     The extension whose Origin is accepted (default: the published extension)
  --export-dir <dir>      An existing folder project_export writes into (default: none, and
                          project_export is refused)
  --pair-timeout-ms <ms>  How long a pair call waits for the panel (default ${DEFAULT_PAIR_TIMEOUT_MS})
  --help                  Print this text
`;

/** Each option that takes a value: the key it is read into, and its kind. */
const VALUE_OPTIONS = new Map([
  ['--port', { key: 'port', kind: 'number' }],
  ['--extension-id', { key: 'extensionId', kind: 'text' }],
  ['--export-dir', { key: 'exportDir', kind: 'text' }],
  ['--pair-timeout-ms', { key: 'pairTimeoutMs', kind: 'number' }],
]);

const WHOLE_NUMBER = /^[0-9]{1,9}$/;

function refusal(message) {
  return { ok: false, message };
}

/**
 * Read the command line. A refusal names the option, never the value.
 *
 * @param {string[]} argv - the arguments after the script's name
 * @returns {{ok: true, help: boolean, options: {port?: number,
 *   extensionId?: string, exportDir?: string, pairTimeoutMs: number}} |
 *   {ok: false, message: string}} an option left out is absent from
 *   `options`, save the wait, which takes this file's default
 */
export function readOptions(argv) {
  const options = { pairTimeoutMs: DEFAULT_PAIR_TIMEOUT_MS };
  const seen = new Set();
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    const cut = word.indexOf('=');
    const flag = cut === -1 ? word : word.slice(0, cut);
    if (flag === '--help') {
      if (cut !== -1) return refusal('--help takes no value.');
      help = true;
      continue;
    }
    const option = VALUE_OPTIONS.get(flag);
    if (option === undefined) {
      return refusal(
        flag.startsWith('--')
          ? 'An option was given that the server does not define.'
          : 'Only options are read from the command line.',
      );
    }
    if (seen.has(flag)) return refusal(`${flag} was given more than once.`);
    seen.add(flag);
    let value;
    if (cut === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = word.slice(cut + 1);
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      return refusal(`${flag} needs a value.`);
    }
    if (option.kind === 'number') {
      if (!WHOLE_NUMBER.test(value)) return refusal(`${flag} takes a whole number.`);
      options[option.key] = Number(value);
    } else {
      options[option.key] = value;
    }
  }
  return { ok: true, help, options };
}
