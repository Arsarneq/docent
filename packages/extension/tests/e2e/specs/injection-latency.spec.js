/**
 * E2E — Programmatic-injection latency (the decisive safety test).
 *
 * With programmatic injection, the recorder is no longer a passive `document_start` manifest content
 * script; the service worker injects it programmatically (injectImmediately:true)
 * on each frame's webNavigation.onCompleted while recording. This test proves the
 * window between "frame finished loading" (T0 = onCompleted) and "recorder ready
 * to capture" (T1 = the recorder's FRAME_READY message) is comfortably below the
 * human deliberate-action floor — i.e. a frame is ready before a user could
 * plausibly act in it, so removing the static early-injection costs no fidelity.
 *
 * The bar is single-sourced: DELIBERATE_ACTION_FLOOR (~200ms, the documented
 * two-action floor) from lib/capture-timing.js; the injection window must be
 * < half that (= 100ms). The measured value is LOGGED so the actual latency is
 * visible in CI output, not just pass/fail.
 *
 * T0 and T1 are both wall-clock (Date.now()): T0 is captured in the SW by a probe
 * on chrome.webNavigation.onCompleted (installed before navigation); T1 is the
 * `readyAt` timestamp the recorder stamps the moment it finishes wiring its
 * listeners and reports via FRAME_READY (recorded by the SW-side ready probe) —
 * the same machine's wall clock, so the difference is the real inject→ready
 * window with no cross-process clock skew or poll-interval slop.
 *
 * Measured across: the main frame, a same-origin srcdoc iframe, and a
 * dynamically created (post-load) subframe.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { DELIBERATE_ACTION_FLOOR } from '../../../lib/capture-timing.js';
import { installReadyProbe, waitForFrameReady } from '../helpers/frame-ready.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

const MAX_INJECTION_WINDOW_MS = DELIBERATE_ACTION_FLOOR / 2; // = 100ms

const routes = new Map();
let server;
let port;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://placeholder');
      const html = routes.get(url.pathname) ?? '<!DOCTYPE html><html><body></body></html>';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
}

const ORIGIN = () => `http://127.0.0.1:${port}`;

const test = base.extend({
  context: async ({}, use) => {
    await startServer();
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    });
    await use(context);
    await context.close();
    routes.clear();
    await new Promise((r) => server.close(r));
  },
  serviceWorker: async ({ context }, use) => {
    let sw;
    if (context.serviceWorkers().length > 0) sw = context.serviceWorkers()[0];
    else sw = await context.waitForEvent('serviceworker');
    await installReadyProbe(sw);
    await use(sw);
  },
});

/** Install a probe in the SW that records Date.now() per completed frame URL. */
async function installCompletedProbe(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    globalThis.__onCompletedAt = {};
    if (globalThis.__latencyProbeInstalled) return;
    globalThis.__latencyProbeInstalled = true;
    chrome.webNavigation.onCompleted.addListener((details) => {
      // Last-write-wins per URL is fine — each test uses fresh URLs.
      globalThis.__onCompletedAt[details.url] = Date.now();
    });
  });
}

async function startRecording(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
  });
}

/** T0 for a given URL: when its onCompleted fired in the SW. */
async function getCompletedAt(serviceWorker, url) {
  return serviceWorker.evaluate((u) => globalThis.__onCompletedAt[u] ?? null, url);
}

test.describe('Programmatic injection latency', () => {
  test('main frame: recorder ready well under the action floor', async ({
    context,
    serviceWorker,
  }) => {
    routes.set('/main', `<!DOCTYPE html><html><body><button id="b">B</button></body></html>`);
    await installCompletedProbe(serviceWorker);
    await startRecording(serviceWorker);

    const page = context.pages()[0] || (await context.newPage());
    const url = `${ORIGIN()}/main`;
    await page.goto(url);
    const t1 = await waitForFrameReady(serviceWorker, url);
    const t0 = await getCompletedAt(serviceWorker, url);
    expect(t0, 'onCompleted fired for the main frame').toBeTruthy();

    const windowMs = t1 - t0;
    console.log(`[injection-latency] main frame inject→ready window = ${windowMs}ms`);
    expect(windowMs).toBeLessThan(MAX_INJECTION_WINDOW_MS);
  });

  test('same-origin srcdoc iframe: recorder ready well under the action floor', async ({
    context,
    serviceWorker,
  }) => {
    routes.set(
      '/srcdoc-parent',
      `<!DOCTYPE html><html><body>
        <iframe id="f" srcdoc="<!DOCTYPE html><html><body><button id='i'>I</button></body></html>" width="300" height="100"></iframe>
      </body></html>`,
    );
    await installCompletedProbe(serviceWorker);
    await startRecording(serviceWorker);

    const page = context.pages()[0] || (await context.newPage());
    const parentUrl = `${ORIGIN()}/srcdoc-parent`;
    await page.goto(parentUrl);
    await waitForFrameReady(serviceWorker, parentUrl);

    // The srcdoc child's frame URL (location.href) is "about:srcdoc"; wait for its
    // FRAME_READY and read the recorder's ready timestamp from the SW probe.
    const t1 = await waitForFrameReady(serviceWorker, 'about:srcdoc');
    const t0 = await getCompletedAt(serviceWorker, 'about:srcdoc');
    expect(t0, 'onCompleted fired for the srcdoc frame').toBeTruthy();

    const windowMs = t1 - t0;
    console.log(`[injection-latency] srcdoc iframe inject→ready window = ${windowMs}ms`);
    expect(windowMs).toBeLessThan(MAX_INJECTION_WINDOW_MS);
  });

  test('dynamic subframe: recorder ready well under the action floor', async ({
    context,
    serviceWorker,
  }) => {
    routes.set('/dynchild', `<!DOCTYPE html><html><body><button id="d">D</button></body></html>`);
    routes.set('/dynparent', `<!DOCTYPE html><html><body></body></html>`);
    await installCompletedProbe(serviceWorker);
    await startRecording(serviceWorker);

    const page = context.pages()[0] || (await context.newPage());
    const parentUrl = `${ORIGIN()}/dynparent`;
    await page.goto(parentUrl);
    await waitForFrameReady(serviceWorker, parentUrl);

    const childUrl = `${ORIGIN()}/dynchild`;
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.id = 'dyn';
      f.src = src;
      document.body.appendChild(f);
    }, childUrl);

    const t1 = await waitForFrameReady(serviceWorker, childUrl);
    const t0 = await getCompletedAt(serviceWorker, childUrl);
    expect(t0, 'onCompleted fired for the dynamic subframe').toBeTruthy();

    const windowMs = t1 - t0;
    console.log(`[injection-latency] dynamic subframe inject→ready window = ${windowMs}ms`);
    expect(windowMs).toBeLessThan(MAX_INJECTION_WINDOW_MS);
  });
});
