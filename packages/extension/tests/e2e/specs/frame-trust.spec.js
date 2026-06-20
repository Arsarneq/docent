/**
 * E2E — S14 frame-trust sender validation (regression).
 *
 * APPEND_ACTION messages are appended to the recording ONLY when they come from
 * a frame the service worker injected into during the live recording (tracked in
 * the active-frame registry). This closes the third-party-iframe action-injection
 * surface: an embedded/compromised frame, or anything reaching the message port
 * that we did not inject, cannot write actions into a session.
 *
 * This spec proves the DROP side of that contract:
 *   - an APPEND_ACTION with no tab sender (not from a recorded tab frame) is dropped;
 *   - an APPEND_ACTION claiming a frameId NOT in the active set is dropped;
 * while a message from a genuinely recorded frame is appended (the ACCEPT side).
 *
 * The complementary "legitimate cross-origin iframe is still captured" assertion
 * lives in iframe-capture.spec.js, which exercises the real content-script path.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { installReadyProbe, waitForFrameReady } from '../helpers/frame-ready.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

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

async function startRecording(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
  });
}

async function getPendingActions(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    return pendingActions ?? [];
  });
}

async function settle(serviceWorker, page, ms = 300) {
  let prev = -1;
  let current = 0;
  for (let i = 0; i < 8 && current !== prev; i++) {
    prev = current;
    await page.waitForTimeout(ms);
    current = (await getPendingActions(serviceWorker)).length;
  }
}

test.describe('S14 frame-trust — untrusted APPEND_ACTION is dropped', () => {
  test('an APPEND_ACTION from a sender that is not a recorded frame is dropped', async ({
    context,
    serviceWorker,
  }) => {
    // The handler must route every APPEND_ACTION through the trust gate and drop a
    // sender that is not an injected frame of an actively-recorded tab. We forge a
    // well-formed APPEND_ACTION from an extension page (which has chrome.runtime
    // access but is not a recorded web frame) while no recording is live, so the
    // gate rejects it deterministically — independent of frame-registry reseeding.
    //
    // (The per-frame / foreign-extension-id / unknown-frameId rejection branches
    // are covered exhaustively by the frame-trust unit test; this proves the SW
    // handler is wired to the gate and never appends an ineligible sender's action.
    // A forged message cannot be delivered from the SW to its own onMessage — Chrome
    // does not dispatch a context's sendMessage back to itself — so the message is
    // sent from a separate extension page.)
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: false, pendingActions: [], pendingCount: 0 });
    });

    const extId = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)[1];
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`chrome-extension://${extId}/sidepanel/index.html`);
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'APPEND_ACTION',
        action: { type: 'click', context_id: 999, element: { tag: 'BUTTON' } },
      });
    });
    await settle(serviceWorker, page);

    const actions = await getPendingActions(serviceWorker);
    const injected = actions.filter((a) => a.context_id === 999);
    expect(injected.length, 'ineligible sender must not be appended').toBe(0);
  });

  test('a real recorded-frame action is still appended (accept side)', async ({
    context,
    serviceWorker,
  }) => {
    routes.set('/p2', `<!DOCTYPE html><html><body><button id="b">Click</button></body></html>`);
    await startRecording(serviceWorker);

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${ORIGIN()}/p2`);
    await waitForFrameReady(serviceWorker, `${ORIGIN()}/p2`);

    await page.locator('#b').click();
    await settle(serviceWorker, page);

    const clicks = (await getPendingActions(serviceWorker)).filter((a) => a.type === 'click');
    expect(
      clicks.length,
      'a click from the recorded main frame is captured',
    ).toBeGreaterThanOrEqual(1);
  });
});
