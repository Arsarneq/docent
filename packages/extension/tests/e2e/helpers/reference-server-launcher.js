/**
 * reference-server-launcher.js — child-process entry for the Reference Sync
 * Server over a private, caller-supplied storage directory.
 *
 * The server's own CLI entry (`server.js`) reads only a port and a token, so a
 * child spawned through it always stores under the machine-wide default
 * directory the file provider documents — shared by every process on the
 * machine, so simultaneous suite runs would contend over its contents. The
 * server's documented override is in-process: `startServer({ storage })` with
 * a `FileStorageProvider(storageDir)`
 * (`reference-implementations/sync-server/server.js` and
 * `storage/file-provider.js` own those seams). This launcher exposes exactly
 * that seam as a spawnable entry, so a spec keeps a real, separate server
 * process while every run gets its own storage directory:
 *
 *   node reference-server-launcher.js --storage-dir <dir> [--port <n>]
 *
 * `--storage-dir` is required: refusing to default keeps this entry from ever
 * constructing a provider over the shared default directory. `--port`
 * defaults to `0` (an ephemeral port). On success `startServer` prints its own
 * "Reference Sync Server listening on <url>" line, which the spawning spec
 * parses for the bound URL exactly as it would when spawning `server.js`.
 *
 * Intentional twin of
 * `packages/desktop/tests/integration/reference-server-launcher.js` — edit
 * both together. Giving the pair one shared home would change which docs
 * govern the file, so each suite keeps its own copy.
 */

import { startServer } from '../../../../../reference-implementations/sync-server/server.js';
import { FileStorageProvider } from '../../../../../reference-implementations/sync-server/storage/file-provider.js';

/**
 * Read a single `--flag <value>` (or `--flag=<value>`) option from an argv
 * slice, returning its value or `undefined` when the flag is absent.
 *
 * @param {string[]} argv The argument list (typically `process.argv.slice(2)`).
 * @param {string} flag The long flag name, e.g. `--storage-dir`.
 * @returns {string|undefined}
 */
function readFlag(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

const argv = process.argv.slice(2);
const storageDir = readFlag(argv, '--storage-dir');
if (typeof storageDir !== 'string' || storageDir.trim() === '') {
  console.error('Usage: node reference-server-launcher.js --storage-dir <dir> [--port <n>]');
  process.exit(1);
}

const rawPort = readFlag(argv, '--port');
const parsedPort = rawPort === undefined ? 0 : Number.parseInt(rawPort, 10);
const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 0;

startServer({ port, storage: new FileStorageProvider(storageDir) }).catch((err) => {
  console.error('Failed to start Reference Sync Server:', err);
  process.exitCode = 1;
});
