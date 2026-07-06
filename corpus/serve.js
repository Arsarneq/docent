/**
 * Corpus page server — serves the committed session pages over loopback HTTP
 * on a FIXED port, so truth files can carry literal deterministic URLs in
 * navigate.url / context source / frame_src (an ephemeral port would make
 * every URL-bearing field differ per run and the known-diffs baseline could
 * never lock).
 *
 * URL rule: http://127.0.0.1:41730/<session-id>/<filename> maps onto
 * corpus/sessions/<session-id>/pages/<filename>.
 *
 * Owned by the corpus Playwright config's `webServer` entry: started once per
 * run, stopped with it, surviving worker restarts/retries. A port collision is
 * an environment error and fails the run at startup (reuseExistingServer is
 * off in the config; this process exits nonzero on EADDRINUSE), never
 * mid-retry.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_PORT = 41730;
export const CORPUS_ORIGIN = `http://127.0.0.1:${CORPUS_PORT}`;

const SESSIONS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'sessions');

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };

function createCorpusServer() {
  return http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    const [, sessionId, ...rest] = req.url.split('?')[0].split('/');
    const file = resolve(SESSIONS_DIR, sessionId ?? '', 'pages', ...rest);
    // Refuse anything that escapes the session's pages/ directory.
    if (!file.startsWith(normalize(SESSIONS_DIR) + sep)) {
      res.writeHead(400).end('bad path');
      return;
    }
    try {
      const body = await readFile(file);
      const ext = file.split('.').pop();
      res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

// Listen only when run as the server process — the corpus spec imports this
// module for CORPUS_ORIGIN, and an import must never bind the port (the
// webServer-owned instance would then collide with the test-collection one).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createCorpusServer();
  server.on('error', (err) => {
    console.error(`corpus server failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(CORPUS_PORT, '127.0.0.1', () => {
    console.log(`corpus server listening on ${CORPUS_ORIGIN}`);
  });
}
