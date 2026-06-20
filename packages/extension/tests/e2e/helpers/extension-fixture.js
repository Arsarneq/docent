/**
 * Playwright fixture that launches Chrome with the Docent extension loaded.
 *
 * Extensions require a persistent browser context (not the default incognito).
 * This fixture provides:
 *   - A browser context with the extension loaded
 *   - A helper to start/stop recording
 *   - A helper to read captured pendingActions from chrome.storage.local
 *   - A helper to clear pending actions between tests
 *
 * Key insight: chrome.storage.local is only accessible from extension contexts
 * (service worker, extension pages), not from regular page contexts. We access
 * it via the service worker's evaluate method.
 *
 * Content script injection: The extension's content script only runs on http/https
 * URLs (per manifest matches). We serve test HTML via a simple local HTTP server.
 *
 * Coverage: Uses CDP Profiler on the testPage to capture content script
 * (recorder.js) execution in the page's isolated world.
 */

import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import { installReadyProbe, waitForFrameReady } from './frame-ready.js';

// The active service worker for the current test. Set by the serviceWorker
// fixture; read by setTestContent (which is a free function with no fixture
// access). Safe because the e2e config runs with workers: 1 (tests serialise).
let currentServiceWorker = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');
const coverageDir = path.resolve(__dirname, '../coverage');
const rawDir = path.resolve(coverageDir, 'raw');

// Ensure coverage directories exist
fs.mkdirSync(rawDir, { recursive: true });

let contentCoverageCounter = 0;

// ─── Local HTTP server for serving test pages ─────────────────────────────────
// The content script only injects on http/https URLs, so we need a real server.

let server;
let serverPort;
let serverReady;

const serverReadyPromise = new Promise((resolve) => {
  serverReady = resolve;
});

function startServer() {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.headers['x-test-html'] || '<html><body></body></html>');
  });
  server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    serverReady();
  });
}

startServer();

/**
 * Extended Playwright test fixture with extension helpers.
 */
export const test = base.extend({
  // Override the default context to use a persistent context with the extension.
  context: async ({}, use) => {
    await serverReadyPromise;
    const context = await chromium.launchPersistentContext('', {
      headless: false, // Extensions don't work in headless mode
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        '--disable-popup-blocking',
      ],
    });
    await use(context);
    await context.close();
  },

  // Provide the extension's service worker for storage access.
  serviceWorker: async ({ context }, use) => {
    let sw;
    if (context.serviceWorkers().length > 0) {
      sw = context.serviceWorkers()[0];
    } else {
      sw = await context.waitForEvent('serviceworker');
    }
    // Install the FRAME_READY probe before any navigation so readiness waits can
    // observe the recorder attaching, and expose the SW to setTestContent.
    await installReadyProbe(sw);
    currentServiceWorker = sw;
    await use(sw);
    currentServiceWorker = null;
  },

  // Provide a page that's ready for testing (recording active, on an http URL).
  testPage: async ({ context, serviceWorker }, use) => {
    // Reuse the default about:blank tab instead of creating a new one.
    const page = context.pages()[0] || (await context.newPage());

    // Start CDP profiler BEFORE navigation so it captures content script load
    let cdpSession = null;
    try {
      cdpSession = await context.newCDPSession(page);
      await cdpSession.send('Profiler.enable');
      await cdpSession.send('Profiler.startPreciseCoverage', {
        callCount: true,
        detailed: true,
      });
    } catch {
      cdpSession = null;
    }

    // Navigate to the local server. With S3 the recorder is no longer a passive
    // manifest content script — it is injected by the SW only while recording,
    // so nothing runs here until recording is turned on below.
    const pageUrl = `http://127.0.0.1:${serverPort}/`;
    await page.goto(pageUrl);

    // Start recording via the service worker. Flipping `recording` true fires the
    // SW's storage.onChanged hook, which programmatically injects the recorder
    // into this tab's frames and seeds the active-frame trust registry.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
    });

    // Wait until the recorder reports FRAME_READY for this frame (via the SW),
    // instead of a fixed sleep — the frame is ready to capture exactly then. The
    // recorder's isolated-world window flag is invisible to this main-world page,
    // so readiness is observed through the service worker.
    await waitForFrameReady(serviceWorker, pageUrl);

    await use(page);

    // Collect content script coverage before stopping
    if (cdpSession) {
      try {
        const { result: coverage } = await cdpSession.send('Profiler.takePreciseCoverage');
        await cdpSession.send('Profiler.stopPreciseCoverage');
        await cdpSession.send('Profiler.disable');
        await cdpSession.detach();

        // Get extension ID for filtering
        const swUrl = serviceWorker.url();
        const match = swUrl.match(/chrome-extension:\/\/([^/]+)/);
        const extensionId = match ? match[1] : '';
        const prefix = `chrome-extension://${extensionId}/`;

        const extensionScripts = coverage
          .filter((entry) => entry.url.startsWith(prefix))
          .map((entry) => ({ url: entry.url, functions: entry.functions }));

        if (extensionScripts.length > 0) {
          const file = path.join(rawDir, `content-${contentCoverageCounter++}.json`);
          fs.writeFileSync(file, JSON.stringify(extensionScripts));
        }
      } catch {
        // Best-effort — don't break tests
      }
    }

    // Stop recording after test.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: false });
    });
    await page.close();
  },
});

export { expect } from '@playwright/test';

/**
 * Set page content via navigation to the local server with the HTML as response.
 * This ensures the content script is active (unlike page.setContent which uses about:blank).
 */
export async function setTestContent(page, html) {
  await page.route(`http://127.0.0.1:${serverPort}/**`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: html,
    });
  });
  const url = `http://127.0.0.1:${serverPort}/test-${Date.now()}`;
  await page.goto(url);
  // After navigation the new document has no recorder until the SW re-injects it
  // (on webNavigation.onCompleted while recording). Wait until the recorder
  // reports FRAME_READY (via the SW) rather than a fixed sleep, so capture is
  // guaranteed live before the test acts. The SW is stashed by the serviceWorker
  // fixture since this free function has no fixture access.
  await waitForFrameReady(currentServiceWorker, url);
}

/**
 * Read pendingActions from chrome.storage.local via the service worker.
 */
export async function getPendingActions(serviceWorker) {
  return await serviceWorker.evaluate(async () => {
    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    return pendingActions ?? [];
  });
}

/**
 * Clear pendingActions in chrome.storage.local via the service worker.
 */
export async function clearPendingActions(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
  });
}

/**
 * Wait for pending actions to stabilize (no new actions for `ms` milliseconds).
 * Useful after triggering an action that may produce delayed side-effects.
 */
export async function waitForActionsToSettle(serviceWorker, page, ms = 400) {
  let prev = -1;
  let current = 0;
  while (current !== prev) {
    prev = current;
    await page.waitForTimeout(ms);
    const actions = await getPendingActions(serviceWorker);
    current = actions.length;
  }
}
