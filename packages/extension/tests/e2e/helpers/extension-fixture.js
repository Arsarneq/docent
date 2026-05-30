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
 * Coverage: When the .instrumented/ directory exists (created by instrument.js),
 * the fixture loads the instrumented extension and collects __coverage__ from
 * the service worker after each test.
 */

import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrcPath = path.resolve(__dirname, '../../..');
const instrumentedPath = path.resolve(__dirname, '../.instrumented');

// Use instrumented extension if available, otherwise use raw source
const extensionPath = fs.existsSync(instrumentedPath) ? instrumentedPath : extensionSrcPath;

// Coverage output directory
const nycOutputDir = path.resolve(__dirname, '../.nyc_output');
let coverageCounter = 0;

function saveCoverage(coverageData) {
  if (!coverageData || Object.keys(coverageData).length === 0) return;
  fs.mkdirSync(nycOutputDir, { recursive: true });
  const file = path.join(nycOutputDir, `coverage-${coverageCounter++}.json`);
  fs.writeFileSync(file, JSON.stringify(coverageData));
}

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

    // Collect coverage from service worker before closing
    if (extensionPath === instrumentedPath) {
      try {
        const sws = context.serviceWorkers();
        if (sws.length > 0) {
          const coverage = await sws[0].evaluate(() => globalThis.__coverage__ || null);
          saveCoverage(coverage);
        }
      } catch {
        // SW may already be terminated — ignore
      }
    }

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
    await use(sw);
  },

  // Provide a page that's ready for testing (recording active, on an http URL).
  testPage: async ({ context, serviceWorker }, use) => {
    // Reuse the default about:blank tab instead of creating a new one.
    const page = context.pages()[0] || (await context.newPage());

    // Navigate to the local server so the content script is injected.
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForTimeout(300); // Let content script initialize

    // Start recording via the service worker.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
    });

    // Wait for the content script to pick up the recording state change.
    await page.waitForTimeout(150);

    await use(page);

    // Collect content script coverage before stopping
    if (extensionPath === instrumentedPath) {
      try {
        const coverage = await page.evaluate(() => window.__coverage__ || null);
        saveCoverage(coverage);
      } catch {
        // Page may have navigated away — ignore
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
  await page.goto(`http://127.0.0.1:${serverPort}/test-${Date.now()}`);
  await page.waitForTimeout(300); // Let content script re-initialize
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
