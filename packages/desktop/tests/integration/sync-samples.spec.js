/**
 * sync-samples.spec.js — End-to-end client-pull guard against stale seed samples
 * (desktop side).
 *
 * The desktop counterpart to the extension's sync-samples e2e. It proves the
 * real desktop client — real `sync-client`, real generated desktop validator,
 * real reconcile — can PULL the bundled `desktop-windows` seed sample from a
 * real running Reference Sync Server and reconcile it into a project, and that
 * it correctly REJECTS the `extension`-stamped sample as a platform mismatch.
 *
 * Together with the shared samples-conformance unit guard and the extension
 * e2e, this gives complete guarding: a schema-shape change that a sample no
 * longer matches fails the desktop client's pull-side `validatePayload` →
 * the sample does not reconcile → this test fails, on the feature PR.
 *
 * ── Why a same-origin reverse proxy (the CORS workaround) ────────────────────
 * In production the desktop app runs in a Tauri webview, whose `connect-src` CSP
 * permits loopback HTTP and which does not enforce browser CORS the way a normal
 * page does — so the real app syncs to the no-CORS reference server directly.
 * This integration test, however, does NOT run in Tauri: it serves the built
 * `dist/` in a plain Chromium page (with `window.__TAURI__` mocked), exactly
 * like the other desktop integration specs. In a plain page a
 * direct `fetch` to a different-origin loopback port is a cross-origin request
 * the browser subjects to CORS, and the reference server sends no CORS headers —
 * so a direct pull would fail for an environment reason that does NOT exist in
 * the real Tauri app (a false negative).
 *
 * The fix keeps the test faithful without polluting the reference server: the
 * same local HTTP server that serves `dist/` also REVERSE-PROXIES the protocol
 * paths (`/projects`, `/projects/:id`) to the child reference server. The webview
 * then fetches a SAME-ORIGIN URL (its own dist origin), so there is no CORS, and
 * the request still reaches the real reference server and exercises the real
 * pull → validate → reconcile path. The reference server stays a faithful opaque
 * no-CORS server; only the test's own dev server gains a proxy.
 *
 * Server lifecycle: the real Reference Sync Server is spawned as a child process
 * on an ephemeral port (`--port 0`), seeded via `POST /__debug/seed
 * { samples: true }` (the real seed path + on-disk sample files), and torn down
 * after the suite.
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, openPanel } from './tauri-mock-fixture.js';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// reference-implementations/sync-server/server.js, from packages/desktop/tests/integration.
const SERVER_ENTRY = path.resolve(
  __dirname,
  '../../../../reference-implementations/sync-server/server.js',
);

/**
 * Spawn the real Reference Sync Server on an ephemeral port; resolve with its
 * base URL once it logs the bound address.
 *
 * @returns {Promise<{ baseUrl: string, stop: () => void }>}
 */
function startReferenceServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      const match = out.match(/listening on (http:\/\/\S+)/);
      if (match) {
        child.stdout.off('data', onData);
        resolve({ baseUrl: match[1].trim(), stop: () => child.kill() });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => {
      out += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== null && code !== 0 && !out.includes('listening on')) {
        reject(new Error(`Reference server exited early (code ${code}):\n${out}`));
      }
    });
    setTimeout(() => reject(new Error(`Reference server did not start in time:\n${out}`)), 10000);
  });
}

/**
 * Reverse-proxy a request from the dist server to the reference server,
 * streaming method, headers (minus host), body, status, and response body
 * through unchanged. Keeps the webview's fetch SAME-ORIGIN so no CORS applies.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} referenceBaseUrl
 */
function proxyToReferenceServer(req, res, referenceBaseUrl) {
  const base = new URL(referenceBaseUrl);
  // Take ONLY the request path; the outbound host always comes from the fixed
  // base, never a value the request could influence. Forward just the sync
  // protocol and debug paths the dist server routes here.
  const { pathname, search } = new URL(req.url, base);
  const isProtocolPath =
    pathname === '/projects' ||
    pathname.startsWith('/projects/') ||
    pathname.startsWith('/__debug/');
  if (!isProtocolPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  // Build the target from the trusted base (host stays pinned, never
  // request-derived) and graft on only the validated path/query. Passing the URL
  // object lets Node format the host correctly — including stripping IPv6
  // brackets, which a raw `base.hostname` (`[::1]`) would leave in.
  const target = new URL(base);
  target.pathname = pathname;
  target.search = search;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host;
    const proxied = http.request(target, { method: req.method, headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    proxied.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Proxy error');
    });
    if (body.length > 0) proxied.write(body);
    proxied.end();
  });
}

let referenceServer;

test.beforeAll(async () => {
  referenceServer = await startReferenceServer();

  // The spawned server uses its default storage dir under the OS temp folder,
  // which persists across runs — reset it first so the pull sees EXACTLY the two
  // bundled samples and nothing left over from a previous run.
  const resetRes = await fetch(`${referenceServer.baseUrl}/__debug/reset`, { method: 'POST' });
  expect(resetRes.status).toBe(200);

  // Seed both bundled samples via the real seed affordance.
  const seedRes = await fetch(`${referenceServer.baseUrl}/__debug/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ samples: true }),
  });
  expect(seedRes.status).toBe(200);
  expect(await seedRes.json()).toEqual({ ok: true, seeded: 2 });
});

test.afterAll(async () => {
  referenceServer?.stop();
});

// The shared dist server (mock injection, static frontend) plus this
// spec's extra route: the sync protocol paths reverse-proxy to the reference
// server, so the webview's fetch stays SAME-ORIGIN and no CORS applies. The
// route registers before the dist files, and runs per request — by which time
// the beforeAll above has the reference server's base URL.
const server = installTauriMockServer({
  routeRequest: (req, res) => {
    if (
      req.url === '/projects' ||
      req.url.startsWith('/projects/') ||
      req.url.startsWith('/__debug/')
    ) {
      proxyToReferenceServer(req, res, referenceServer.baseUrl);
      return true;
    }
    return false;
  },
});

test.describe('Sync pulls the bundled seed samples end-to-end (desktop)', () => {
  test('pulls and reconciles the desktop sample; rejects the extension sample as a stamp mismatch', async ({
    page,
  }) => {
    await openPanel(page, server);

    // Configure the sync endpoint to the SAME-ORIGIN dist server (which proxies
    // the protocol paths to the reference server). Same origin ⇒ no CORS.
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', server.origin());
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    let summaryText = '';
    page.on('dialog', (dialog) => {
      summaryText = dialog.message();
      dialog.accept();
    });

    await expect(page.locator('#btn-sync')).toBeEnabled();
    await page.click('#btn-sync');
    await expect(page.locator('#btn-sync')).toHaveText('Sync', { timeout: 15000 });

    const DESK_PROJECT = 'Desktop (Windows) sample — Invoice export flow';
    const EXT_PROJECT = 'Extension sample — Expense report submission';

    // The desktop sample reconciled into a real project.
    await expect(page.locator('.card-item-name', { hasText: DESK_PROJECT })).toBeVisible({
      timeout: 10000,
    });

    // The extension sample was rejected as a platform mismatch — not reconciled.
    await expect(page.locator('.card-item-name', { hasText: EXT_PROJECT })).toHaveCount(0);

    // Summary: pulled the desktop sample, skipped the extension one as
    // incompatible (mismatch routes to `mismatched`, never `errors`).
    expect(summaryText).toMatch(/Pulled\s+1\s+project/i);
    expect(summaryText).toMatch(/[Ss]kipped/);
    expect(summaryText).not.toMatch(/failed schema validation/i);
  });
});
