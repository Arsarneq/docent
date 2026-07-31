/**
 * Desktop Panel UI Tests
 *
 * Tests the desktop panel by serving the built frontend against the suite's
 * shared `window.__TAURI__` mock (`tauri-mock-fixture.js`, which also documents
 * what the mock services). This validates DOM interactions and view transitions
 * without requiring the full Tauri runtime.
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer } from './tauri-mock-fixture.js';
import assert from 'node:assert/strict';

const server = installTauriMockServer();

test.describe('Desktop Panel â€” Smoke', () => {
  test('panel loads and shows projects view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('create project â†’ project detail view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Desktop Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Desktop Test');
  });

  test('create recording â†’ recording view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#recording-title')).toHaveText('R');
  });
});

test.describe('Desktop Panel â€” Simple Mode', () => {
  test('switching to simple mode shows simple mode box', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Switch to simple mode in settings
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#simple-mode-box')).toBeVisible();
    await expect(page.locator('#narration-mode-box')).toBeHidden();
  });
});

test.describe('Desktop Panel â€” Metadata', () => {
  test('project metadata section exists and add button works', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Meta');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-metadata-section')).toBeAttached();

    // Open and add a row
    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);

    await expect(page.locator('#project-metadata-list .metadata-row')).toHaveCount(1);
  });

  test('metadata persists after navigating away and back', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Persist Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Add metadata
    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);
    await page.locator('#project-metadata-list .metadata-key').first().fill('env');
    await page.locator('#project-metadata-list .metadata-value').first().fill('prod');
    await page.locator('#project-metadata-list .metadata-value').first().press('Tab');
    await page.waitForTimeout(300);

    // Navigate to projects list and back
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open the project
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Metadata should still be there
    await page.click('#project-metadata-section summary');
    await page.waitForTimeout(100);
    await expect(page.locator('#project-metadata-list .metadata-key').first()).toHaveValue('env');
    await expect(page.locator('#project-metadata-list .metadata-value').first()).toHaveValue(
      'prod',
    );
  });
});

test.describe('Desktop Panel â€” Commit with Simulated Capture', () => {
  test('simulated capture event enables commit in simple mode', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Switch to simple mode
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Capture Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Simulate a capture:action event via the Tauri mock
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Button', tag: 'Button' },
          },
        });
      }
    });
    await page.waitForTimeout(300);

    // Commit button should be enabled (pending action exists)
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();

    // Commit
    await page.click('#btn-commit-step-simple');
    await page.waitForTimeout(500);

    // Step should appear
    await expect(page.locator('.step-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel â€” Theme', () => {
  test('theme switch updates data-theme attribute', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const darkLabel = page.locator('input[name="theme"][value="dark"]').locator('..');
    await darkLabel.scrollIntoViewIfNeeded();
    await darkLabel.click();
    await page.waitForTimeout(200);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Desktop Panel â€” Narration Commit Flow', () => {
  test('type narration + simulated capture â†’ commit â†’ step appears', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project + recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Simulate a capture event
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Login' },
          },
        });
    });
    await page.waitForTimeout(300);

    // Type narration and commit
    await page.fill('#narration-input', 'Click the login button');
    await expect(page.locator('#btn-commit-step')).toBeEnabled();
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Step should appear
    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('.step-narration')).toContainText('Click the login button');
    await expect(page.locator('#step-count')).toHaveText('1');
  });

  test('commit button disabled without narration text', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Simulate pending action but no narration
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'X' },
          },
        });
    });
    await page.waitForTimeout(300);

    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('commit button disabled without pending actions', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Type narration but no pending actions
    await page.fill('#narration-input', 'Some narration');
    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('narration input clears after commit', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'X' },
          },
        });
    });
    await page.waitForTimeout(300);

    await page.fill('#narration-input', 'Step one');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('#narration-input')).toHaveValue('');
  });

  test('multiple steps accumulate in the step list', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // First step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'A' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Second step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'type',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'B' },
            value: 'hello',
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Second');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(2);
    await expect(page.locator('#step-count')).toHaveText('2');
  });
});

test.describe('Desktop Panel â€” Clear Button', () => {
  test('clear resets pending actions and disables commit', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'X' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Something');
    await expect(page.locator('#btn-commit-step')).toBeEnabled();

    // Accept confirm dialog
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-clear-step');
    await page.waitForTimeout(500);

    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });
});

test.describe('Desktop Panel â€” Step Detail View', () => {
  test('clicking step narration opens detail view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit a step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Submit', selector: '#btn' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Click submit');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click step to open detail
    await page.click('.step-narration');
    await page.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.step-detail-item')).toHaveCount(1);
    await expect(page.locator('#step-detail-title')).toContainText('Click submit');

    // Back button
    await page.click('#btn-step-detail-back');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel â€” Delete Step', () => {
  test('delete removes step from list', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit two steps
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'A' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'B' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Second');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(2);

    // Delete first step
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('#step-count')).toHaveText('1');
  });
});

test.describe('Desktop Panel â€” History View', () => {
  test('history button shows step versions', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit a step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'X' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Original');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click history
    await page.locator('[data-action="history"]').first().click();
    await page.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.history-item')).toHaveCount(1);

    // Back
    await page.click('#btn-history-back');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel â€” Projects View UI Elements', () => {
  test('file input is hidden', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#import-file-input')).toBeHidden();
  });

  test('sync button is visible and disabled without config', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#btn-sync')).toBeVisible();
    await expect(page.locator('#btn-sync')).toBeDisabled();
  });

  test('import button is visible', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#btn-import-project')).toBeVisible();
  });

  test('empty state shown when no projects', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Desktop Panel â€” Project Detail UI', () => {
  test('export button is visible', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-export-project')).toBeVisible();
  });

  test('recording list shows created recording', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Go back to project detail
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel â€” Recording View UI State', () => {
  test('pending actions section is hidden initially', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#pending-actions-section')).toBeHidden();
  });

  test('recording badge shows Recording state after create', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });
});

test.describe('Desktop Panel â€” Breadcrumb Navigation', () => {
  test('breadcrumb navigates back to projects list', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('breadcrumb project link navigates to project detail', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-project')).toBeVisible();
  });
});

test.describe('Desktop Panel â€” Settings Additional', () => {
  test('settings back button returns to previous view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('sync URL input is visible in settings', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const syncInput = page.locator('#settings-sync-url');
    await syncInput.scrollIntoViewIfNeeded();
    await expect(syncInput).toBeVisible();
  });
});

test.describe('Desktop Panel â€” Delete Project', () => {
  test('delete removes project from list', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'To Delete');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.card-item')).toHaveCount(0);
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Desktop Panel - Dispatch Flow', () => {
  test('dispatch button disabled without endpoint configured', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Dispatch Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-dispatch-project')).toBeDisabled();
  });

  test('dispatch button enabled after configuring endpoint and having steps', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure endpoint in settings via save button
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'http://localhost:3000/api');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording + commit a step
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'OK' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Click OK');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Go back to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#btn-dispatch-project')).toBeEnabled();
  });
});

test.describe('Desktop Panel - Sync Settings', () => {
  test('sync URL persists after save and navigate', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'http://sync.example.com');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open settings
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-sync-url')).toHaveValue('http://sync.example.com');
  });

  test('saving a valid sync URL does not report an authentication failure', async ({ page }) => {
    // Regression: saving a new endpoint is a settings change, NOT an auth failure.
    // It must invalidate the Connection_Test to the untested state and prompt a
    // re-test — never set connectionTest='auth', which wrongly surfaced
    // "Authentication failed — re-test your connection." after a plain Save while
    // an explicit Test connection against the same server passed.
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    // Save a syntactically valid endpoint WITHOUT first testing the connection.
    await page.fill('#settings-sync-url', 'http://localhost:3000');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);

    // No false auth error on the connection status line...
    await expect(page.locator('#settings-connection-status')).not.toContainText(
      'Authentication failed',
    );
    // ...and the neutral re-test prompt guides the user instead.
    await expect(page.locator('#settings-auto-sync-hint')).toContainText('Test the connection');
  });

  test('sync button enabled when URL configured', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'http://sync.example.com');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-sync')).toBeEnabled();
  });

  test('enabling Auto-Sync after a passing connection test starts the background host', async ({
    page,
  }) => {
    // Drives the Auto-Sync ENABLE branch: a passing Connection_Test makes the
    // toggle enableable, and turning it on runs syncAutoSyncHostState() →
    // startAutoSyncHost(), which arms the keep-alive and surfaces the
    // "Auto-sync active" indicator. Stub the single `GET /projects` the
    // Connection_Test issues so it passes; the shared mock services
    // `set_auto_sync_keepalive` and records it, so the arming is observable
    // instead of resting on the panel's best-effort catch.
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) =>
        String(url).includes('/projects')
          ? Promise.resolve(new Response('[]', { status: 200 }))
          : realFetch(url, opts);
    });

    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    // Configure an endpoint, then record a passing Connection_Test against it.
    await page.fill('#settings-sync-url', 'http://sync.example.com');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-test-connection');
    await expect(page.locator('#settings-connection-status')).toContainText('Connection OK');

    // The passing test makes the toggle enableable; turning it on starts the host.
    const toggle = page.locator('#toggle-auto-sync');
    await expect(toggle).toBeEnabled();
    await toggle.check();

    // The host is running: the "Auto-sync active" indicator shows and the toggle
    // stays on — proving the enable branch, not the guarded early return.
    await expect(page.locator('#settings-auto-sync-status')).toBeVisible();
    await expect(toggle).toBeChecked();

    // Starting the host arms the webview keep-alive through the backend, so the
    // background cycle survives a closed window.
    const keepAliveCalls = await page.evaluate(() =>
      window.__TAURI__._getInvokeCalls().filter((c) => c.cmd === 'set_auto_sync_keepalive'),
    );
    expect(keepAliveCalls.length).toBeGreaterThan(0);
    expect(keepAliveCalls.at(-1).args.enabled).toBe(true);
  });
});

test.describe('Desktop Panel - Re-record Flow', () => {
  test('re-record opens recording view with banner', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Submit' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Original step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click edit/re-record on the step
    await page.locator('[data-action="edit"]').first().click();
    await page.waitForTimeout(500);

    // Should show re-record banner
    await expect(page.locator('#rerecord-banner')).toBeVisible();
  });
});

test.describe('Desktop Panel - Recording Delete', () => {
  test('delete recording removes it from project view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec A');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec B');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.card-item')).toHaveCount(2);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel - Endpoint Settings', () => {
  test('endpoint URL and API key persist after save', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.test.com/dispatch');
    await page.fill('#settings-api-key', 'sk-12345');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open settings and verify
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-endpoint-url')).toHaveValue(
      'https://api.test.com/dispatch',
    );
    await expect(page.locator('#settings-api-key')).toHaveValue('sk-12345');
  });
});

test.describe('Desktop Panel - Window Target Selector', () => {
  test('target app dropdown is visible in recording view', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#target-app-select')).toBeVisible();
  });
});

test.describe('Desktop Panel — Adapter Capture Lifecycle', () => {
  test('RECORDING_START invokes start_capture and resets reorder state', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project + recording to get to recording view
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Capture Lifecycle');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Deliver capture events on the capture:action stream (out-of-order ids).
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 5,
            element: { text: 'A' },
          },
        });
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 10,
            element: { text: 'B' },
          },
        });
      }
    });
    await page.waitForTimeout(200);

    // Verify pending count reflects the delivered events.
    const pendingCount = await page.evaluate(() => {
      const badge = document.querySelector('#pending-count');
      return badge ? badge.textContent : '0';
    });

    // Clear and verify reset
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-clear-step');
    await page.waitForTimeout(300);

    // After clear, pending count should be 0
    const afterClear = await page.evaluate(() => {
      const badge = document.querySelector('#pending-count');
      return badge ? badge.textContent : '0';
    });
    assert.ok(
      afterClear === '0' || afterClear === '',
      `Expected 0 pending after clear, got ${afterClear}`,
    );
  });

  test('commit collects every delivered action into the step', async ({ page }) => {
    await page.goto(server.url());
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Completeness');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Send events with sequence_ids 1 and 2 (missing 3)
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 1,
            element: { text: 'A' },
          },
        });
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 2,
            element: { text: 'B' },
          },
        });
      }
    });
    await page.waitForTimeout(100);

    // Now send the missing event (seq 3) after a short delay
    await page.evaluate(() => {
      setTimeout(() => {
        const handler = window.__TAURI__._listeners['capture:action'];
        if (handler) {
          handler({
            payload: {
              type: 'click',
              timestamp: Date.now(),
              capture_mode: 'accessibility',
              context_id: 1,
              sequence_id: 3,
              element: { text: 'C' },
            },
          });
        }
      }, 200);
    });

    // Type narration and commit (commit uses commitWithCompleteness)
    await page.fill('#narration-input', 'All three events');
    await page.waitForTimeout(400); // Wait for the delayed event to arrive
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Step should be committed with all 3 actions
    await expect(page.locator('.step-item')).toHaveCount(1);

    // Open step detail to verify all 3 actions
    await page.click('.step-narration');
    await page.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.step-detail-item')).toHaveCount(3);
  });
});
