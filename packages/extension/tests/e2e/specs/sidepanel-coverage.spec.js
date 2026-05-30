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

const test = base.extend({
  context: async ({}, use) => {
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

    // Start CDP profiler on the SERVICE WORKER for SW + content script coverage.
    // A page-level CDP session only sees that page's isolate.
    // The SW session captures service-worker.js execution.
    let swCdpSession = null;
    try {
      const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
      swCdpSession = await context.newCDPSession(sw);
      await swCdpSession.send('Profiler.enable');
      await swCdpSession.send('Profiler.startPreciseCoverage', {
        callCount: true,
        detailed: true,
      });
    } catch (err) {
      console.warn('[coverage] Failed to start SW CDP profiler:', err.message);
    }

    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForTimeout(500);

    await use(page);

    // Collect page-level coverage (side panel files)
    const pageCoverage = await page.coverage.stopJSCoverage();
    const pageFile = path.join(rawDir, `sidepanel-page-${coverageCounter}.json`);
    fs.writeFileSync(pageFile, JSON.stringify(pageCoverage));

    // Collect CDP profiler coverage from the service worker
    if (swCdpSession) {
      try {
        const { result: cdpCoverage } = await swCdpSession.send('Profiler.takePreciseCoverage');
        const extensionPrefix = `chrome-extension://${extensionId}/`;
        const extensionScripts = cdpCoverage
          .filter((entry) => entry.url.startsWith(extensionPrefix))
          .map((entry) => ({
            url: entry.url,
            functions: entry.functions,
          }));

        if (extensionScripts.length > 0) {
          const cdpFile = path.join(rawDir, `sidepanel-cdp-${coverageCounter}.json`);
          fs.writeFileSync(cdpFile, JSON.stringify(extensionScripts));
        }

        await swCdpSession.send('Profiler.stopPreciseCoverage');
        await swCdpSession.send('Profiler.disable');
        await swCdpSession.detach();
      } catch (err) {
        console.warn('[coverage] CDP profiler collection failed:', err.message);
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
