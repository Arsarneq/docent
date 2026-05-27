/**
 * Panel UI Tests — Core Flows
 *
 * Tests the narration commit flow, re-record, drag-reorder, and dispatch
 * confirmation. Uses the same panelPage fixture as panel-simple-mode.spec.js.
 */

import { test as base, expect, chromium } from '@playwright/test';
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

/**
 * Helper: create a project and recording, ending in the recording view.
 */
async function createProjectAndRecording(panelPage, projectName = 'Test', recordingName = 'Rec') {
  await panelPage.click('#btn-new-project');
  await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-project-name', projectName);
  await panelPage.click('#btn-new-project-create');
  await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await panelPage.click('#btn-new-recording');
  await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-recording-name', recordingName);
  await panelPage.click('#btn-new-recording-create');
  await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
}

/**
 * Helper: simulate pending actions by injecting them into chrome.storage.local
 * via the service worker.
 */
async function simulatePendingActions(serviceWorker, actions) {
  await serviceWorker.evaluate(async (acts) => {
    await chrome.storage.local.set({
      pendingActions: acts,
      pendingCount: acts.length,
    });
  }, actions);
}

test.describe('Narration Commit Flow', () => {
  test('type narration + pending actions → commit → step appears in list', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProjectAndRecording(panelPage);

    // Simulate captured actions
    await simulatePendingActions(serviceWorker, [
      { type: 'click', timestamp: Date.now(), element: { text: 'Login' } },
    ]);

    // Wait for pending count to propagate to the panel
    await panelPage.waitForTimeout(300);

    // Type narration
    await panelPage.fill('#narration-input', 'Click the login button');

    // Commit button should be enabled
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();

    // Click commit
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Step should appear in the list
    const stepItems = panelPage.locator('.step-item');
    await expect(stepItems).toHaveCount(1);

    // Step narration should be visible
    await expect(panelPage.locator('.step-narration')).toContainText('Click the login button');

    // Step count badge should show 1
    await expect(panelPage.locator('#step-count')).toHaveText('1');
  });

  test('commit button disabled without narration text', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    // Simulate pending actions
    await simulatePendingActions(serviceWorker, [
      { type: 'click', timestamp: Date.now(), element: { text: 'X' } },
    ]);
    await panelPage.waitForTimeout(300);

    // No narration typed — button should be disabled
    await expect(panelPage.locator('#btn-commit-step')).toBeDisabled();
  });

  test('commit button disabled without pending actions', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);

    // Type narration but no pending actions
    await panelPage.fill('#narration-input', 'Some narration');

    await expect(panelPage.locator('#btn-commit-step')).toBeDisabled();
  });

  test('narration input clears after successful commit', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    await simulatePendingActions(serviceWorker, [
      { type: 'click', timestamp: Date.now(), element: { text: 'X' } },
    ]);
    await panelPage.waitForTimeout(300);

    await panelPage.fill('#narration-input', 'Step one');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    await expect(panelPage.locator('#narration-input')).toHaveValue('');
  });

  test('multiple steps accumulate in the step list', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    // Commit first step
    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'First step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Commit second step
    await simulatePendingActions(serviceWorker, [{ type: 'type', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'Second step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    await expect(panelPage.locator('.step-item')).toHaveCount(2);
    await expect(panelPage.locator('#step-count')).toHaveText('2');
  });
});

test.describe('Dispatch Confirmation Flow', () => {
  test('configure endpoint → Send button becomes enabled', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    // Commit a step so there's something to dispatch
    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'A step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Go to project view
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Send button should be disabled (no endpoint configured)
    await expect(panelPage.locator('#btn-dispatch-project')).toBeDisabled();

    // Configure endpoint in settings
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const endpointInput = panelPage.locator('#settings-endpoint-url');
    await endpointInput.scrollIntoViewIfNeeded();
    await endpointInput.fill('http://localhost:9999');
    await panelPage.click('#btn-settings-dispatch-save');
    await panelPage.waitForTimeout(300);

    // Go back to project
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Send button should now be enabled
    await expect(panelPage.locator('#btn-dispatch-project')).toBeEnabled();
  });
});

test.describe('Clear Button', () => {
  test('clear button resets pending actions and disables commit', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProjectAndRecording(panelPage);

    // Simulate pending actions
    await simulatePendingActions(serviceWorker, [
      { type: 'click', timestamp: Date.now(), element: { text: 'X' } },
      { type: 'type', timestamp: Date.now(), value: 'hello' },
    ]);
    await panelPage.waitForTimeout(300);

    // Type narration so commit would be enabled
    await panelPage.fill('#narration-input', 'Some step');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();

    // Accept the confirm dialog that clear triggers
    panelPage.on('dialog', (dialog) => dialog.accept());

    // Click clear
    await panelPage.click('#btn-clear-step');
    await panelPage.waitForTimeout(500);

    // Commit button should be disabled (no pending actions)
    await expect(panelPage.locator('#btn-commit-step')).toBeDisabled();
  });
});

test.describe('Step Detail View', () => {
  test('clicking step narration opens detail view with actions', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProjectAndRecording(panelPage);

    // Commit a step with actions
    await simulatePendingActions(serviceWorker, [
      {
        type: 'click',
        timestamp: Date.now(),
        element: { text: 'Submit', selector: '#btn-submit' },
      },
      {
        type: 'type',
        timestamp: Date.now(),
        element: { selector: '#email' },
        value: 'test@example.com',
      },
    ]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'Fill form and submit');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Click the step narration to open detail
    await panelPage.click('.step-narration');
    await panelPage.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    // Detail view should show the actions
    const actionItems = panelPage.locator('.step-detail-item');
    await expect(actionItems).toHaveCount(2);

    // Title should contain the step narration
    await expect(panelPage.locator('#step-detail-title')).toContainText('Fill form and submit');
  });

  test('back button returns to recording view', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'A step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Open detail
    await panelPage.click('.step-narration');
    await panelPage.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    // Click back
    await panelPage.click('#btn-step-detail-back');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(panelPage.locator('#view-recording')).toBeVisible();
  });
});

test.describe('Delete Step', () => {
  test('delete removes step from list', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    // Commit two steps
    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'First');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'Second');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    await expect(panelPage.locator('.step-item')).toHaveCount(2);

    // Accept confirm dialog
    panelPage.on('dialog', (dialog) => dialog.accept());

    // Delete the first step
    await panelPage.locator('[data-action="delete"]').first().click();
    await panelPage.waitForTimeout(500);

    // Should have 1 step remaining
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
    await expect(panelPage.locator('#step-count')).toHaveText('1');
  });
});

test.describe('Simple Mode Commit to Export', () => {
  test('simple mode step appears in export with step_type and expect', async ({
    panelPage,
    serviceWorker,
  }) => {
    // Switch to simple mode
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

    await createProjectAndRecording(panelPage);

    // Select validation + present
    const validationLabel = panelPage
      .locator('input[name="step-type"][value="validation"]')
      .locator('..');
    await validationLabel.scrollIntoViewIfNeeded();
    await validationLabel.click();
    await panelPage.waitForTimeout(100);

    // Simulate pending actions
    await simulatePendingActions(serviceWorker, [
      { type: 'click', timestamp: Date.now(), element: { text: 'Success message' } },
    ]);
    await panelPage.waitForTimeout(300);

    // Commit
    await panelPage.click('#btn-commit-step-simple');
    await panelPage.waitForTimeout(500);

    // Verify step appears
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
    await expect(panelPage.locator('.step-narration')).toContainText('validation');
    await expect(panelPage.locator('.step-narration')).toContainText('present');
  });
});

test.describe('Theme Switching', () => {
  test('changing theme updates data-theme attribute', async ({ panelPage }) => {
    // Default should be auto
    const html = panelPage.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'auto');

    // Switch to dark
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const darkLabel = panelPage.locator('input[name="theme"][value="dark"]').locator('..');
    await darkLabel.scrollIntoViewIfNeeded();
    await darkLabel.click();
    await panelPage.waitForTimeout(200);

    await expect(html).toHaveAttribute('data-theme', 'dark');

    // Switch to light
    const lightLabel = panelPage.locator('input[name="theme"][value="light"]').locator('..');
    await lightLabel.scrollIntoViewIfNeeded();
    await lightLabel.click();
    await panelPage.waitForTimeout(200);

    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});

test.describe('History View', () => {
  test('history button shows step versions', async ({ panelPage, serviceWorker }) => {
    await createProjectAndRecording(panelPage);

    // Commit a step
    await simulatePendingActions(serviceWorker, [{ type: 'click', timestamp: Date.now() }]);
    await panelPage.waitForTimeout(300);
    await panelPage.fill('#narration-input', 'Original step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Click history button on the step
    await panelPage.locator('[data-action="history"]').first().click();
    await panelPage.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    // Should show at least one history entry
    const historyItems = panelPage.locator('.history-item');
    await expect(historyItems).toHaveCount(1);

    // Back button returns to recording
    await panelPage.click('#btn-history-back');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Projects View — No Visual Artifacts', () => {
  test('file input is hidden on projects list', async ({ panelPage }) => {
    // The import file input should be hidden — not visible as a "Choose File" button
    await expect(panelPage.locator('#import-file-input')).toBeHidden();
  });
});

test.describe('Projects View — UI Elements', () => {
  test('sync button is visible and disabled without sync config', async ({ panelPage }) => {
    await expect(panelPage.locator('#btn-sync')).toBeVisible();
    await expect(panelPage.locator('#btn-sync')).toBeDisabled();
  });

  test('import button is visible', async ({ panelPage }) => {
    await expect(panelPage.locator('#btn-import-project')).toBeVisible();
  });

  test('new project button is visible', async ({ panelPage }) => {
    await expect(panelPage.locator('#btn-new-project')).toBeVisible();
  });

  test('empty state message shown when no projects', async ({ panelPage }) => {
    await expect(panelPage.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Project Detail — UI Elements', () => {
  test('export button is visible', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);
    // Go back to project view
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(panelPage.locator('#btn-export-project')).toBeVisible();
  });

  test('recording list shows created recording', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(panelPage.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Recording View — UI State', () => {
  test('pending actions section is hidden initially', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);
    await expect(panelPage.locator('#pending-actions-section')).toBeHidden();
  });

  test('recording badge shows Recording state', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);
    // After creating a recording, it starts recording automatically
    await expect(panelPage.locator('#recording-badge')).toContainText('Recording');
  });
});

test.describe('Breadcrumb Navigation', () => {
  test('breadcrumb shows project name and allows navigation back', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);

    // Breadcrumb should show project name
    await expect(panelPage.locator('#bc-project')).toBeVisible();

    // Click projects breadcrumb to go back to list
    await panelPage.click('#bc-projects');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(panelPage.locator('#view-projects')).toBeVisible();
  });

  test('breadcrumb project link navigates to project detail', async ({ panelPage }) => {
    await createProjectAndRecording(panelPage);

    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(panelPage.locator('#view-project')).toBeVisible();
  });
});

test.describe('Settings View — Additional Elements', () => {
  test('settings back button returns to previous view', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(panelPage.locator('#view-projects')).toBeVisible();
  });

  test('sync URL input is visible in settings', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const syncInput = panelPage.locator('#settings-sync-url');
    await syncInput.scrollIntoViewIfNeeded();
    await expect(syncInput).toBeVisible();
  });
});

test.describe('Delete Project', () => {
  test('delete removes project from list', async ({ panelPage }) => {
    // Create a project
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'To Delete');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Go back to projects list
    await panelPage.click('#bc-projects');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Should have 1 project
    await expect(panelPage.locator('.card-item')).toHaveCount(1);

    // Accept confirm dialog and delete
    panelPage.on('dialog', (dialog) => dialog.accept());
    await panelPage.locator('[data-action="delete"]').first().click();
    await panelPage.waitForTimeout(500);

    // Should have 0 projects
    await expect(panelPage.locator('.card-item')).toHaveCount(0);
    await expect(panelPage.locator('#projects-empty')).toBeVisible();
  });
});
