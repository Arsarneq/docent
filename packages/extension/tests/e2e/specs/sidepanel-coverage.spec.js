/**
 * Side Panel Coverage Spec
 *
 * Opens the extension's side panel page directly and exercises its core
 * flows to collect V8 coverage. This spec exists specifically to get
 * panel.js, adapter-chrome.js, and dispatch.js into the coverage report.
 *
 * The side panel is a chrome-extension:// page that Playwright can navigate
 * to and collect page.coverage from.
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
    // Get the extension ID from the service worker URL
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
    // Open the side panel page directly
    const page = await context.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForTimeout(500); // Let panel.js initialize

    await use(page);

    // Stop coverage and save
    const coverage = await page.coverage.stopJSCoverage();
    const outFile = path.join(rawDir, `sidepanel-coverage-${coverageCounter++}.json`);
    fs.writeFileSync(outFile, JSON.stringify(coverage));
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
    // Create project first
    await sidePanelPage.click('#btn-new-project');
    await sidePanelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await sidePanelPage.fill('#new-project-name', 'P');
    await sidePanelPage.click('#btn-new-project-create');
    await sidePanelPage.waitForSelector('#view-project', { timeout: 5000 });

    // Create recording
    await sidePanelPage.click('#btn-new-recording');
    await sidePanelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await sidePanelPage.fill('#new-recording-name', 'R');
    await sidePanelPage.click('#btn-new-recording-create');
    await sidePanelPage.waitForSelector('#view-recording', { timeout: 5000 });
    await expect(sidePanelPage.locator('#recording-title')).toHaveText('R');
  });
});
