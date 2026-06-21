/**
 * E2E Tests — Cross-origin / nested / dynamic iframe capture (#93).
 *
 * The existing iframe tests in interactions.spec.js cover SAME-ORIGIN `srcdoc`
 * frames. This file covers the gaps #93 calls out:
 *   - a genuinely CROSS-ORIGIN iframe (different host → different origin),
 *   - NESTED iframes (2 levels deep),
 *   - a DYNAMICALLY created iframe (added after page load),
 *   - `frame_src` correctly distinguishes in-frame actions from top-frame ones.
 *
 * Cross-origin without a second server: one HTTP server is reached via two
 * hostnames — `127.0.0.1` and `localhost` — which the browser treats as
 * distinct origins. The parent loads on one host and embeds an iframe served
 * from the other, so the child frame is truly cross-origin to its parent.
 *
 * The service worker injects the recorder programmatically into every frame
 * while recording — on record-start (all current frames) and on each frame's
 * webNavigation.onCompleted (covering srcdoc, nested, and dynamically created
 * child frames) — so capture inside cross-origin frames is expected to work (or,
 * if a frame is inaccessible, to simply capture nothing — never to crash the
 * parent's capture).
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { installReadyProbe, waitForFrameReady } from '../helpers/frame-ready.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

// ─── Two-origin HTTP server ────────────────────────────────────────────────────
// One server, reached as both 127.0.0.1 (origin A) and localhost (origin B).
// Pages are supplied per-path via an in-memory route table.

const routes = new Map(); // path -> html
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
    // Bind to all interfaces so both 127.0.0.1 and localhost resolve to it.
    server.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}

const ORIGIN_A = () => `http://127.0.0.1:${port}`;
const ORIGIN_B = () => `http://localhost:${port}`;

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
    if (context.serviceWorkers().length > 0) {
      sw = context.serviceWorkers()[0];
    } else {
      sw = await context.waitForEvent('serviceworker');
    }
    await installReadyProbe(sw);
    await use(sw);
  },
});

async function startRecording(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
  });
}

/**
 * Wait until the top frame's recorder is ready — observed via the SW's FRAME_READY
 * message (the recorder's isolated-world flag is invisible to the page). Child
 * frames are injected per-frame on their own onCompleted; the per-test settle()
 * below absorbs that, but the top frame being ready is the deterministic signal
 * that programmatic injection has begun.
 */
async function waitForTopFrameReady(serviceWorker, page) {
  await waitForFrameReady(serviceWorker, page.url());
}

async function getPendingActions(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    return pendingActions ?? [];
  });
}

/** Settle: wait until the action count stops growing. */
async function settle(serviceWorker, page, ms = 400) {
  let prev = -1;
  let current = 0;
  for (let i = 0; i < 10 && current !== prev; i++) {
    prev = current;
    await page.waitForTimeout(ms);
    current = (await getPendingActions(serviceWorker)).length;
  }
}

test.describe('Cross-origin iframe capture (#93)', () => {
  test('click inside a cross-origin iframe is captured with its own frame_src', async ({
    context,
    serviceWorker,
  }) => {
    // Child served from origin B with a button.
    routes.set(
      '/child',
      `<!DOCTYPE html><html><body><button id="inner" style="padding:1rem">Inner</button></body></html>`,
    );
    // Parent served from origin A, embedding the origin-B child (cross-origin).
    routes.set(
      '/parent',
      `<!DOCTYPE html><html><body>
        <button id="outer">Outer</button>
        <iframe id="x" src="${ORIGIN_B()}/child" width="400" height="120"></iframe>
      </body></html>`,
    );

    await startRecording(serviceWorker);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${ORIGIN_A()}/parent`);
    await waitForTopFrameReady(serviceWorker, page);
    await page.waitForTimeout(300); // let the SW inject into the child frame too

    // Click the outer (top-frame) button, then the inner (cross-origin) one.
    await page.locator('#outer').click();
    await page.frameLocator('#x').locator('#inner').click();
    await settle(serviceWorker, page);

    const actions = await getPendingActions(serviceWorker);
    const clicks = actions.filter((a) => a.type === 'click');

    // Both clicks captured.
    expect(clicks.length).toBeGreaterThanOrEqual(2);

    // Top-frame click has null frame_src; the cross-origin child's click
    // carries its own (origin-B) frame_src.
    const topClick = clicks.find((c) => c.frame_src == null);
    const frameClick = clicks.find((c) => c.frame_src != null);
    expect(topClick, 'a top-frame click with null frame_src').toBeTruthy();
    expect(frameClick, 'a child-frame click with a frame_src').toBeTruthy();
    expect(frameClick.frame_src).toContain('/child');
    expect(frameClick.frame_src).toContain('localhost'); // origin B
  });

  test('parent-page capture keeps working alongside a cross-origin iframe', async ({
    context,
    serviceWorker,
  }) => {
    routes.set('/c2', `<!DOCTYPE html><html><body><input id="f" /></body></html>`);
    routes.set(
      '/p2',
      `<!DOCTYPE html><html><body>
        <button id="top">Top</button>
        <iframe id="x" src="${ORIGIN_B()}/c2" width="400" height="100"></iframe>
      </body></html>`,
    );

    await startRecording(serviceWorker);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${ORIGIN_A()}/p2`);
    await waitForTopFrameReady(serviceWorker, page);
    await page.waitForTimeout(300);

    // Interacting with the parent after a cross-origin frame is present must
    // still capture normally (the frame doesn't break the top frame's hooks).
    await page.locator('#top').click();
    await settle(serviceWorker, page);

    const types = (await getPendingActions(serviceWorker)).map((a) => a.type);
    expect(types).toContain('click');
  });
});

test.describe('Nested iframe capture (#93)', () => {
  test('click inside a 2-level-deep iframe is captured', async ({ context, serviceWorker }) => {
    // Grandchild (origin A), middle frame embeds it, parent embeds the middle.
    routes.set(
      '/grandchild',
      `<!DOCTYPE html><html><body><button id="deep" style="padding:1rem">Deep</button></body></html>`,
    );
    routes.set(
      '/middle',
      `<!DOCTYPE html><html><body><iframe id="inner" src="${ORIGIN_A()}/grandchild" width="300" height="80"></iframe></body></html>`,
    );
    routes.set(
      '/top',
      `<!DOCTYPE html><html><body><iframe id="outer" src="${ORIGIN_A()}/middle" width="350" height="120"></iframe></body></html>`,
    );

    await startRecording(serviceWorker);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${ORIGIN_A()}/top`);
    await waitForTopFrameReady(serviceWorker, page);
    await page.waitForTimeout(400); // inject into the two nested frames too

    await page.frameLocator('#outer').frameLocator('#inner').locator('#deep').click();
    await settle(serviceWorker, page);

    const actions = await getPendingActions(serviceWorker);
    const deepClick = actions.find((a) => a.type === 'click' && a.frame_src != null);
    expect(deepClick, 'click captured from the 2-level-deep frame').toBeTruthy();
    expect(deepClick.frame_src).toContain('/grandchild');
  });
});

test.describe('Dynamic iframe capture (#93)', () => {
  test('click inside a dynamically created iframe is captured', async ({
    context,
    serviceWorker,
  }) => {
    routes.set(
      '/dynchild',
      `<!DOCTYPE html><html><body><button id="dyn" style="padding:1rem">Dynamic</button></body></html>`,
    );
    routes.set(
      '/dynparent',
      `<!DOCTYPE html><html><body><button id="add">Add frame</button></body></html>`,
    );

    await startRecording(serviceWorker);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${ORIGIN_A()}/dynparent`);
    await waitForTopFrameReady(serviceWorker, page);

    // Create the iframe AFTER load — exercises the SW's frame re-injection.
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.id = 'dyn';
      f.src = src;
      f.width = '400';
      f.height = '100';
      document.body.appendChild(f);
    }, `${ORIGIN_A()}/dynchild`);
    await page.waitForTimeout(600); // let the SW inject into the new frame

    await page.frameLocator('#dyn').locator('#dyn').click();
    await settle(serviceWorker, page);

    const actions = await getPendingActions(serviceWorker);
    const dynClick = actions.find((a) => a.type === 'click' && a.frame_src != null);
    expect(dynClick, 'click captured from the dynamically created frame').toBeTruthy();
    expect(dynClick.frame_src).toContain('/dynchild');
  });
});
