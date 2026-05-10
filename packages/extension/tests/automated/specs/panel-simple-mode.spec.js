/**
 * Panel UI Tests — Simple Mode & Metadata Editor
 *
 * Tests the panel UI for the simple mode recording feature and
 * the metadata editor. Opens the side panel page directly via
 * the extension's chrome-extension:// URL.
 *
 * The panel page uses chrome.runtime.sendMessage to communicate with
 * the service worker. We wait for the projects list to render (indicating
 * the panel has fully initialized) before interacting.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

// Custom fixture that provides a panel page
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

  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    // Wait for the panel to fully initialize — the projects view becomes visible
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await use(page);
    await page.close();
  },
});

test.describe('Simple Mode UI', () => {

  test('settings view shows recording mode radio group', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const narrationRadio = panelPage.locator('input[name="recording-mode"][value="narration"]');
    const simpleRadio = panelPage.locator('input[name="recording-mode"][value="simple"]');

    await expect(narrationRadio).toBeAttached();
    await expect(simpleRadio).toBeAttached();
    await expect(narrationRadio).toBeChecked();
  });

  test('switching to simple mode shows simple mode box in recording view', async ({ panelPage }) => {
    // Switch to simple mode in settings
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    // Scroll to and click the simple mode radio's label
    const simpleLabel = panelPage.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await panelPage.waitForTimeout(200);

    // Go back and create a project + recording
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Test Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Test Recording');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Verify simple mode box is visible, narration box is hidden
    await expect(panelPage.locator('#simple-mode-box')).toBeVisible();
    await expect(panelPage.locator('#narration-mode-box')).toBeHidden();
  });

  test('narration mode shows narration box in recording view', async ({ panelPage }) => {
    // Default is narration mode — create project + recording directly
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Test Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Test Recording');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Verify narration box is visible, simple mode box is hidden
    await expect(panelPage.locator('#narration-mode-box')).toBeVisible();
    await expect(panelPage.locator('#simple-mode-box')).toBeHidden();
  });

  test('step-type validation shows expect group', async ({ panelPage }) => {
    // Switch to simple mode
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel2 = panelPage.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel2.scrollIntoViewIfNeeded();
    await simpleLabel2.click();
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Rec');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Expect group should be hidden by default (action is selected)
    await expect(panelPage.locator('#expect-group')).toBeHidden();

    // Click validation radio
    const validationLabel = panelPage.locator('input[name="step-type"][value="validation"]').locator('..');
    await validationLabel.scrollIntoViewIfNeeded();
    await validationLabel.click();
    await panelPage.waitForTimeout(100);

    // Expect group should now be visible
    await expect(panelPage.locator('#expect-group')).toBeVisible();

    // Click action radio again
    const actionLabel = panelPage.locator('input[name="step-type"][value="action"]').locator('..');
    await actionLabel.scrollIntoViewIfNeeded();
    await actionLabel.click();
    await panelPage.waitForTimeout(100);

    // Expect group should be hidden again
    await expect(panelPage.locator('#expect-group')).toBeHidden();
  });

  test('simple mode commit button is disabled when no pending actions', async ({ panelPage }) => {
    // Switch to simple mode
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel3 = panelPage.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel3.scrollIntoViewIfNeeded();
    await simpleLabel3.click();
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Rec');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit button should be disabled (no pending actions)
    await expect(panelPage.locator('#btn-commit-step-simple')).toBeDisabled();
  });
});

test.describe('Metadata Editor UI', () => {

  test('project detail view shows metadata section', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(panelPage.locator('#project-metadata-section')).toBeAttached();
  });

  test('clicking Add creates a new metadata row', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Open the metadata details
    await panelPage.click('#project-metadata-section summary');
    await panelPage.waitForTimeout(100);

    // Click Add
    await panelPage.click('#btn-add-project-metadata');
    await panelPage.waitForTimeout(100);

    const rows = panelPage.locator('#project-metadata-list .metadata-row');
    await expect(rows).toHaveCount(1);

    // Click Add again
    await panelPage.click('#btn-add-project-metadata');
    await panelPage.waitForTimeout(100);

    await expect(rows).toHaveCount(2);
  });

  test('metadata row accepts key and value input', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Open metadata and add a row
    await panelPage.click('#project-metadata-section summary');
    await panelPage.click('#btn-add-project-metadata');
    await panelPage.waitForTimeout(100);

    // Fill in key and value
    const keyInput = panelPage.locator('#project-metadata-list .metadata-key').first();
    const valueInput = panelPage.locator('#project-metadata-list .metadata-value').first();

    await keyInput.fill('jira-ticket');
    await valueInput.fill('PROJ-123');
    await valueInput.press('Tab');
    await panelPage.waitForTimeout(200);

    await expect(keyInput).toHaveValue('jira-ticket');
    await expect(valueInput).toHaveValue('PROJ-123');
  });

  test('remove button deletes a metadata row', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Open metadata and add two rows
    await panelPage.click('#project-metadata-section summary');
    await panelPage.click('#btn-add-project-metadata');
    await panelPage.click('#btn-add-project-metadata');
    await panelPage.waitForTimeout(100);

    const rows = panelPage.locator('#project-metadata-list .metadata-row');
    await expect(rows).toHaveCount(2);

    // Click remove on the first row
    await panelPage.locator('#project-metadata-list .metadata-remove').first().click();
    await panelPage.waitForTimeout(200);

    await expect(rows).toHaveCount(1);
  });

  test('recording view shows metadata section', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta Project');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Meta Recording');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(panelPage.locator('#recording-metadata-section')).toBeAttached();
  });
});
