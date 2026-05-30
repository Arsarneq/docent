/**
 * Side Panel + CDP Coverage Spec
 *
 * Collects coverage for ALL extension source files:
 * - Side panel files (panel.js, adapter-chrome.js, dispatch.js) via page.coverage
 * - Service worker + content scripts via CDP Profiler.takePreciseCoverage
 *
 * The CDP profiler captures coverage from every V8 isolate in the browser,
 * including service workers and content script isolated worlds.
 */

import { test as base, chromium, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');
const coverageDir = path.resolve(__dirname, '../coverage');
const rawDir = path.resolve(coverageDir, 'raw');

// Ensure coverage directories exist
fs.mkdirSync(rawDir, { recursive: true });

let coverageCounter = 0;

const DEBUG_PORT = 9339; // Fixed port for CDP access to SW

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        `--remote-debugging-port=${DEBUG_PORT}`,
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let sw;
    if (context.serviceWorkers().length > 0) {
      sw = context.serviceWorkers()[0];
    } else {
      sw = await context.waitForEvent('serviceworker');
    }
    const url = sw.url();
    const match = url.match(/chrome-extension:\/\/([^/]+)/);
    const id = match ? match[1] : null;
    await use(id);
  },

  sidePanelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();

    // Start page-level coverage for side panel files
    await page.coverage.startJSCoverage({ resetOnNavigation: false });

    // Start coverage on the service worker via raw CDP WebSocket
    let swConnection = null;
    try {
      const { connectToServiceWorker } = await import('../helpers/cdp-sw-coverage.js');
      swConnection = await connectToServiceWorker(DEBUG_PORT, extensionId);
    } catch (err) {
      console.warn('[coverage] SW CDP connection failed:', err.message);
    }

    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForTimeout(500);

    await use(page);

    // Collect page-level coverage (side panel files)
    const pageCoverage = await page.coverage.stopJSCoverage();
    const pageFile = path.join(rawDir, `sidepanel-page-${coverageCounter}.json`);
    fs.writeFileSync(pageFile, JSON.stringify(pageCoverage));

    // Collect service worker coverage via raw CDP
    if (swConnection) {
      try {
        const { collectAndClose } = await import('../helpers/cdp-sw-coverage.js');
        const swScripts = await collectAndClose(swConnection, extensionId);
        if (swScripts.length > 0) {
          const cdpFile = path.join(rawDir, `sidepanel-sw-${coverageCounter}.json`);
          fs.writeFileSync(cdpFile, JSON.stringify(swScripts));
        }
      } catch (err) {
        console.warn('[coverage] SW coverage collection failed:', err.message);
      }
    }

    coverageCounter++;
    await page.close();
  },
});

test.describe('Side Panel — Coverage Collection', () => {
  test('panel loads and shows projects view', async ({ sidePanelPage }) => {
    await expect(sidePanelPage.locator('#view-projects')).toBeVisible();
  });

  test('create project flow', async ({ sidePanelPage }) => {
    await sidePanelPage.click('#btn-new-project');
    await sidePanelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await sidePanelPage.fill('#new-project-name', 'Coverage Test');
    await sidePanelPage.click('#btn-new-project-create');
    await sidePanelPage.waitForSelector('#view-project', { timeout: 5000 });
    await expect(sidePanelPage.locator('#project-title')).toHaveText('Coverage Test');
  });

  test('settings view loads dispatch and sync fields', async ({ sidePanelPage }) => {
    await sidePanelPage.click('#btn-settings');
    await sidePanelPage.waitForSelector('#view-settings', { timeout: 5000 });
    await expect(sidePanelPage.locator('#settings-endpoint-url')).toBeVisible();
    await expect(sidePanelPage.locator('#settings-sync-url')).toBeVisible();
  });

  test('theme switch works', async ({ sidePanelPage }) => {
    await sidePanelPage.click('#btn-settings');
    await sidePanelPage.waitForSelector('#view-settings', { timeout: 5000 });
    const darkLabel = sidePanelPage.locator('input[name="theme"][value="dark"]').locator('..');
    await darkLabel.click();
    await sidePanelPage.waitForTimeout(200);
    await expect(sidePanelPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('create recording flow', async ({ sidePanelPage }) => {
    await sidePanelPage.click('#btn-new-project');
    await sidePanelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await sidePanelPage.fill('#new-project-name', 'P');
    await sidePanelPage.click('#btn-new-project-create');
    await sidePanelPage.waitForSelector('#view-project', { timeout: 5000 });

    await sidePanelPage.click('#btn-new-recording');
    await sidePanelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await sidePanelPage.fill('#new-recording-name', 'R');
    await sidePanelPage.click('#btn-new-recording-create');
    await sidePanelPage.waitForSelector('#view-recording', { timeout: 5000 });
    await expect(sidePanelPage.locator('#recording-title')).toHaveText('R');
  });
});
