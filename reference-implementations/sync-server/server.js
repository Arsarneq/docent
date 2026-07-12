/**
 * server.js — entry point for the Reference Sync Server.
 *
 * This is the single composition root of the server. It does three things and
 * nothing else:
 *
 *   1. Reads its configuration — the listening port and the optional
 *      Static_Token — from the environment and the command line (see
 *      {@link readConfig}).
 *   2. Constructs the default `File_Storage_Provider` HERE, at the single
 *      construction site: every other module reaches
 *      stored projects only through the injected `Storage_Provider` interface,
 *      so an adopter swaps the backend by changing this one line.
 *   3. Creates the `http.Server` from the router and listens on the loopback
 *      interface ({@link BIND_HOST}), defaulting to the documented port `3000`
 *      when none is configured, then logs the bound URL.
 *
 * Runtime: Node.js standard library only — `node:http` for the server and
 * `node:url` for the main-module guard — plus the in-package router and
 * file-provider. No third-party web framework, no build step (Requirements
 * 8.1, 8.3).
 *
 * Configuration (env takes precedence is documented per key below):
 *
 *   - Port:  `--port <n>` argv flag, else the `PORT` environment variable,
 *            else the default `3000`.
 *   - Token: `--token <t>` argv flag, else the `SYNC_TOKEN` environment
 *            variable, else unset → the server runs open.
 *
 * Import vs. run: importing this module does NOT bind a port. The listener only
 * starts when the file is executed as the program entry point (the
 * `import.meta.url === pathToFileURL(process.argv[1]).href` main guard at the
 * bottom). Tests and harnesses can therefore `import { createServer }` (or
 * `startServer`) to drive the server on an ephemeral port without the
 * module-load side effect of binding `3000`.
 *
 * This file is part of Docent.
 * Licensed under the GNU General Public License v3.0
 * See LICENSE in the project root for license information.
 *
 * @module server
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { createRouter } from './router.js';
import { FileStorageProvider } from './storage/file-provider.js';

/** The documented default listening port when none is configured. */
export const DEFAULT_PORT = 3000;

/**
 * The interface the server binds. Loopback only, deliberately: the server runs
 * open (no token) by default, so binding loopback is the security boundary that
 * keeps a token-free local instance off the network. An adopter who wants it
 * reachable binds an explicit host and adds a token (see the protocol's
 * server-scope and authentication guidance) — not this default.
 */
export const BIND_HOST = '127.0.0.1';

/** Environment variable read for the listening port. */
export const PORT_ENV_VAR = 'PORT';

/** Environment variable read for the optional Static_Token. */
export const TOKEN_ENV_VAR = 'SYNC_TOKEN';

/**
 * Read a single `--flag <value>` (or `--flag=<value>`) option from an argv
 * slice, returning its value or `undefined` when the flag is absent.
 *
 * @param {string[]} argv The argument list (typically `process.argv.slice(2)`).
 * @param {string} flag   The long flag name, e.g. `--port`.
 * @returns {string|undefined}
 */
function readFlag(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === flag) {
      // `--flag value` form: the value is the next argument.
      return argv[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      // `--flag=value` form.
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Resolve the server configuration from argv and the environment.
 *
 * Precedence, per key:
 *   - port:  `--port` argv flag → `PORT` env var → {@link DEFAULT_PORT}.
 *   - token: `--token` argv flag → `SYNC_TOKEN` env var → `null` (open server).
 *
 * The argv flag wins over the environment so a developer can override a shell
 * export on a single run. A blank/whitespace-only token is treated as unset so
 * an empty `SYNC_TOKEN=` does not accidentally lock the server with an
 * unusable token.
 *
 * @param {object} [options]
 * @param {string[]} [options.argv]  Defaults to `process.argv.slice(2)`.
 * @param {NodeJS.ProcessEnv} [options.env] Defaults to `process.env`.
 * @returns {{ port: number, token: string|null }}
 */
export function readConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const rawPort = readFlag(argv, '--port') ?? env[PORT_ENV_VAR];
  const parsedPort = rawPort === undefined ? NaN : Number.parseInt(rawPort, 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;

  const rawToken = readFlag(argv, '--token') ?? env[TOKEN_ENV_VAR];
  const token = typeof rawToken === 'string' && rawToken.trim() !== '' ? rawToken : null;

  return { port, token };
}

/**
 * Build the `http.Server` for the Reference Sync Server WITHOUT binding a port.
 *
 * This is the single construction site for the default `File_Storage_Provider`:
 * the concrete provider is instantiated here and passed
 * to the router, which only ever talks to the `Storage_Provider` interface. An
 * adopter swaps the backend by replacing the provider on this one line. A test
 * may inject its own `storage` (e.g. a `File_Storage_Provider` over a fresh
 * temp dir) to avoid touching the shared default directory.
 *
 * @param {object} [options]
 * @param {string|null} [options.token]
 *   The Static_Token, or null/undefined for an open server.
 * @param {import('./storage/provider.js').StorageProvider} [options.storage]
 *   An optional Storage_Provider override; defaults to a `File_Storage_Provider`
 *   over `<os.tmpdir()>/docent-reference-sync-server`.
 * @returns {{ server: import('node:http').Server, storage: import('./storage/provider.js').StorageProvider }}
 *   The unbound server and the storage provider it uses.
 */
export function createServer({ token = null, storage = new FileStorageProvider() } = {}) {
  const server = http.createServer(createRouter({ storage, token }));
  return { server, storage };
}

/**
 * Create AND start the server, returning once it is listening.
 *
 * Listens on the loopback interface ({@link BIND_HOST}) on the given port (or
 * the documented default `3000`) and resolves with the live server, the bound
 * address, and the storage provider. Passing port `0` binds an ephemeral port —
 * the shape the test harness (Task 10.1) uses to run isolated suites without
 * contending for `3000`.
 *
 * @param {object} [options]
 * @param {number} [options.port]   Defaults to {@link DEFAULT_PORT}.
 * @param {string|null} [options.token]
 * @param {import('./storage/provider.js').StorageProvider} [options.storage]
 * @param {(message: string) => void} [options.log]
 *   Sink for the bound-URL line; defaults to `console.log`. Pass a no-op to
 *   silence startup logging in tests.
 * @returns {Promise<{
 *   server: import('node:http').Server,
 *   storage: import('./storage/provider.js').StorageProvider,
 *   port: number,
 *   url: string,
 * }>}
 */
export function startServer({
  port = DEFAULT_PORT,
  token = null,
  storage = new FileStorageProvider(),
  log = console.log,
} = {}) {
  const { server } = createServer({ token, storage });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.removeListener('error', reject);
      const address = server.address();
      // `address()` is an object for a TCP socket once listening. Derive the
      // actual bound port (important when `port` was 0) and a readable URL.
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      // Format the display host from the bound family so the banner stays honest
      // if BIND_HOST is ever changed to an IPv6 loopback (`::1`). With the
      // default IPv4 BIND_HOST this is always `localhost`.
      const host =
        typeof address === 'object' && address !== null && address.family === 'IPv6'
          ? '[::1]'
          : 'localhost';
      const url = `http://${host}:${boundPort}`;
      log(`Reference Sync Server listening on ${url}`);
      resolve({ server, storage, port: boundPort, url });
    });
  });
}

// ── Main-module guard ───────────────────────────────────────────────────────
// Only bind a port when this file is the program entry point (`node server.js`,
// the package "start" script). Importing the module — as tests and the Task 10
// harness do — has no side effect, so a consumer chooses an ephemeral port via
// startServer() instead of inheriting the default 3000 binding.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, token } = readConfig();
  startServer({ port, token }).catch((err) => {
    console.error('Failed to start Reference Sync Server:', err);
    process.exitCode = 1;
  });
}
