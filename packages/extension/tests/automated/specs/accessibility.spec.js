/**
 * Accessibility Audit — axe-core WCAG 2.1 AA
 *
 * Scans each major panel view for accessibility violations.
 * Uses @axe-core/playwright to run automated checks.
 *
 * Note: This catches machine-detectable issues only. Full WCAG compliance
 * requires manual testing with assistive technologies and expert review.
 *
 * Covers issue #29.
 */

import { test as base, expect, chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

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
    const id = url.match(/chrome-extension:\/\/([^/]+)/)?.[1];
    await use(id);
  },

  serviceWorker: async ({ context }, use) => {
    let sw;
    if (context.serviceWorkers().length > 0) {
      sw = context.serviceWorkers()[0];
    } else {
      sw = await context.waitForEvent('serviceworker');
    }
    await use(sw);
  },

  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await use(page);
    await page.close();
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runAxe(page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations;
}

function formatViolations(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `    ${n.html}`).join('\n');
      return `[${v.impact}] ${v.id}: ${v.help}\n${nodes}`;
    })
    .join('\n\n');
}

async function createProjectAndRecording(panelPage, serviceWorker) {
  await panelPage.click('#btn-new-project');
  await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-project-name', 'A11y Test');
  await panelPage.click('#btn-new-project-create');
  await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await panelPage.click('#btn-new-recording');
  await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-recording-name', 'Flow');
  await panelPage.click('#btn-new-recording-create');
  await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  // Commit a step so we have content to inspect
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      pendingActions: [
        { type: 'click', timestamp: Date.now(), element: { text: 'OK', selector: '#ok' } },
      ],
      pendingCount: 1,
    });
  });
  await panelPage.waitForTimeout(300);
  await panelPage.fill('#narration-input', 'Click OK');
  await panelPage.click('#btn-commit-step');
  await panelPage.waitForTimeout(500);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Accessibility — WCAG 2.1 AA', () => {
  test('projects list view has no violations', async ({ panelPage }) => {
    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('new project form has no violations', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('project detail view has no violations', async ({ panelPage }) => {
    // Create a project to get to the detail view
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'A11y Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('new recording form has no violations', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'A11y');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('recording view (narration mode) has no violations', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProjectAndRecording(panelPage, serviceWorker);

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('recording view (simple mode) has no violations', async ({ panelPage, serviceWorker }) => {
    // Switch to simple mode via settings
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = panelPage
      .locator('input[name="recording-mode"][value="simple"]')
      .locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project and recording (without committing a step — simple mode has different flow)
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'A11y Simple');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Flow');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('step detail view has no violations', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage, serviceWorker);

    // Open step detail
    await panelPage.click('.step-narration');
    await panelPage.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('settings view has no violations', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  test('step history view has no violations', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage, serviceWorker);

    // Open history
    await panelPage.locator('[data-action="history"]').first().click();
    await panelPage.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    const violations = await runAxe(panelPage);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});
