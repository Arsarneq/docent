/**
 * Desktop Panel UI Tests
 *
 * Tests the desktop panel by serving the built frontend against the suite's
 * shared `window.__TAURI__` mock (`tauri-mock-fixture.js`, which also documents
 * what the mock services). This validates DOM interactions and view transitions
 * without requiring the full Tauri runtime.
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, fireCaptureActions, openPanel } from './tauri-mock-fixture.js';
import assert from 'node:assert/strict';

const server = installTauriMockServer();

test.describe('Desktop Panel â€” Smoke', () => {
  test('panel loads and shows projects view', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('create project â†’ project detail view', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Desktop Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Desktop Test');
  });

  test('create recording â†’ recording view', async ({ page }) => {
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'Button', tag: 'Button' },
      },
    ]);
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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'Login' },
      },
    ]);
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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await page.waitForTimeout(300);

    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('commit button disabled without pending actions', async ({ page }) => {
    await openPanel(page, server);

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
    await openPanel(page, server);

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

    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await page.waitForTimeout(300);

    await page.fill('#narration-input', 'Step one');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('#narration-input')).toHaveValue('');
  });

  test('multiple steps accumulate in the step list', async ({ page }) => {
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'A' },
      },
    ]);
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Second step
    await fireCaptureActions(page, [
      {
        type: 'type',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'B' },
        value: 'hello',
      },
    ]);
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
    await openPanel(page, server);

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

    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'Submit', selector: '#btn' },
      },
    ]);
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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'A' },
      },
    ]);
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'B' },
      },
    ]);
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
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
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
    await openPanel(page, server);
    await expect(page.locator('#import-file-input')).toBeHidden();
  });

  test('sync button is visible and disabled without config', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#btn-sync')).toBeVisible();
    await expect(page.locator('#btn-sync')).toBeDisabled();
  });

  test('import button is visible', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#btn-import-project')).toBeVisible();
  });

  test('empty state shown when no projects', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Desktop Panel â€” Project Detail UI', () => {
  test('export button is visible', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-export-project')).toBeVisible();
  });

  test('recording list shows created recording', async ({ page }) => {
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('sync URL input is visible in settings', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const syncInput = page.locator('#settings-sync-url');
    await syncInput.scrollIntoViewIfNeeded();
    await expect(syncInput).toBeVisible();
  });
});

test.describe('Desktop Panel â€” Delete Project', () => {
  test('delete removes project from list', async ({ page }) => {
    await openPanel(page, server);

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
    await openPanel(page, server);

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Dispatch Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-dispatch-project')).toBeDisabled();
  });

  test('dispatch button enabled after configuring endpoint and having steps', async ({ page }) => {
    await openPanel(page, server);

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

    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'OK' },
      },
    ]);
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

/** The sync server the restart cases save. https, so an API key beside it clears the save-time URL policy. */
const HTTPS_SYNC_URL = 'https://sync.example.com';

/** How long a settle wait gives the blob, kept under the 15 s per-test budget. */
const SETTLE_TIMEOUT_MS = 8000;

/** How long a settle wait leaves between reads before calling the blob still. */
const SETTLE_POLL_MS = 100;

/**
 * Wait until the blob the mock holds — what `load_state` answers, and so the
 * state a re-opened panel starts from — has stopped moving and carries every
 * key of `expected`, present and equal.
 *
 * Both halves are load-bearing. One save click writes twice: the adapter's seam
 * write, and the panel's own whole-blob save behind it. Only the second decides
 * what survives a re-open, so a wait that merely catches the blob holding the
 * values can be satisfied by the first write and pass over a panel that has
 * stopped mirroring. This reads the blob twice with a gap and takes it as
 * settled only when no further `save_state` arrived in between — the two writes
 * of one click are microtasks apart, never a whole interval.
 *
 * The loop lives here rather than in the page because the settle needs state
 * across reads — the previous write count — to know the panel's trailing
 * whole-blob save has landed behind the seam's write; a single predicate,
 * evaluated once per poll with nothing carried between polls, would be satisfied
 * by that first write. `page.waitForFunction` is the right tool for a stateless
 * synchronous predicate, as openPanel's readiness gate uses it, and the wrong
 * one here.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, unknown>} expected
 * @param {number} [timeout]
 * @returns {Promise<void>}
 */
async function waitForSavedSettings(page, expected, timeout = SETTLE_TIMEOUT_MS) {
  const probeBlob = () => {
    const writes = window.__TAURI__
      ._getInvokeCalls()
      .filter((call) => call.cmd === 'save_state').length;
    let settings = null;
    try {
      settings = JSON.parse(window.__TAURI__._getSavedState()).settings ?? null;
    } catch {
      settings = null;
    }
    return { writes, settings };
  };
  const holds = (settings) =>
    !!settings &&
    Object.entries(expected).every(([key, value]) => key in settings && settings[key] === value);

  const deadline = Date.now() + timeout;
  let previousWrites = -1;
  let held = null;
  let cause;
  while (Date.now() < deadline) {
    try {
      const probe = await page.evaluate(probeBlob);
      held = probe.settings;
      if (probe.writes === previousWrites && holds(held)) return;
      previousWrites = probe.writes;
    } catch (err) {
      cause = err;
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  throw new Error(
    `[panel-desktop] the persisted blob never settled to ${JSON.stringify(expected)} within ` +
      `${timeout}ms; it holds ${JSON.stringify(held)}. The last write wins, and the last write is the panel's own whole-blob save — so a seam save the panel does not mirror back leaves the blob at the value here.`,
    cause ? { cause } : undefined,
  );
}

test.describe('Desktop Panel - Sync Settings', () => {
  test('sync URL persists after save and navigate', async ({ page }) => {
    await openPanel(page, server);

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

  // Opening the panel again as a fresh document starts it over from the
  // persisted blob, so what these two read is the file. Re-opening Settings
  // inside one document proves nothing here — the fields repopulate from the
  // in-memory copy the panel is already holding, which is the case above. That
  // is what makes these two the assertion the panel's mirror-back beside the
  // seam save answers to: the seam's own write is followed by the panel's
  // whole-blob save, and only the mirrored values reach the blob that survives
  // a re-open (the rule is the desktop caller model in the PlatformAdapter
  // typedef's header, packages/shared/views/adapter.js).
  test('sync settings survive a restart', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', HTTPS_SYNC_URL);
    await page.fill('#settings-sync-api-key', 'sync-key');
    await page.click('#btn-settings-sync-save');
    // Wait on the observable rather than a duration: the save is done when the
    // blob a re-opened panel would load carries the value.
    await waitForSavedSettings(page, { syncUrl: HTTPS_SYNC_URL, syncApiKey: 'sync-key' });

    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-sync-url')).toHaveValue(HTTPS_SYNC_URL);
    await expect(page.locator('#settings-sync-api-key')).toHaveValue('sync-key');
  });

  // What this one discriminates, over and above its sibling: a panel that
  // mirrors the set path but stops mirroring the clear path. That is why it
  // saves a value first and clears it second — the clear has to have something
  // to undo, and a blob that was never written would read as cleared anyway,
  // the values the panel loads defaulting to null.
  test('clearing sync settings survives a restart', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', HTTPS_SYNC_URL);
    await page.fill('#settings-sync-api-key', 'sync-key');
    await page.click('#btn-settings-sync-save');
    await waitForSavedSettings(page, { syncUrl: HTTPS_SYNC_URL, syncApiKey: 'sync-key' });

    // Clear both, then re-open.
    await page.fill('#settings-sync-url', '');
    await page.fill('#settings-sync-api-key', '');
    await page.click('#btn-settings-sync-save');
    // The cleared shape the panel's mirror-back writes: both keys present and
    // null, which is the write DSH-2's clear branch acts on.
    await waitForSavedSettings(page, { syncUrl: null, syncApiKey: null });

    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-sync-url')).toHaveValue('');
    await expect(page.locator('#settings-sync-api-key')).toHaveValue('');
  });

  test('saving a valid sync URL does not report an authentication failure', async ({ page }) => {
    // Regression: saving a new endpoint is a settings change, NOT an auth failure.
    // It must invalidate the Connection_Test to the untested state and prompt a
    // re-test — never set connectionTest='auth', which wrongly surfaced
    // "Authentication failed — re-test your connection." after a plain Save while
    // an explicit Test connection against the same server passed.
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    // `set_auto_sync_keepalive` and records every invoke, so the assertion below
    // observes the arming directly rather than inferring it from the UI.
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) =>
        String(url).includes('/projects')
          ? Promise.resolve(new Response('[]', { status: 200 }))
          : realFetch(url, opts);
    });

    await openPanel(page, server);

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
    await openPanel(page, server);

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

    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { text: 'Submit' },
      },
    ]);
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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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
    await openPanel(page, server);

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

    // The recording-create path starts capture by a direct invoke, so clear the
    // record first: what this test reads afterwards is the seam route's own
    // start_capture and nothing else.
    await page.evaluate(() => window.__TAURI__._clearInvokeCalls());

    // A parked sentinel is the observable this route has: the adapter holds a
    // sentinel that arrives with no waiter in its seen set, which is exactly what
    // the reorder reset clears, and the canonical mock never engages a barrier.
    // The adapter also evicts a parked id once its wait window elapses, so widen
    // that window first — with it far longer than this test can take, the id's
    // disappearance is attributable to the reset and to nothing else. The second
    // setter call echoes the value back, which is how this reads that the adapter
    // took the wider window rather than clamping it.
    const WIDENED_WINDOW_MS = 60_000;
    const [previousWindow, echoedWindow] = await page.evaluate(async (ms) => {
      const mod = await import('/adapter-tauri.js');
      return [mod._testOnly.setBarrierWaitTimeout(ms), mod._testOnly.setBarrierWaitTimeout(ms)];
    }, WIDENED_WINDOW_MS);
    assert.equal(
      echoedWindow,
      WIDENED_WINDOW_MS,
      'the adapter should hold the widened eviction window unclamped',
    );

    try {
      const parkedBarrierId = 9101;
      await fireCaptureActions(page, [{ type: 'barrier_complete', barrier_id: parkedBarrierId }]);

      // Reach the live adapter module the panel itself holds — the served page
      // imports it by the same URL, under the shipped CSP.
      const beforeSend = await page.evaluate(async () => {
        const mod = await import('/adapter-tauri.js');
        return mod._testOnly.seenBarrierIds();
      });
      assert.ok(
        beforeSend.includes(parkedBarrierId),
        `the parked sentinel should be held before the send, got ${JSON.stringify(beforeSend)}`,
      );

      // Take the seam route to capture start.
      const sent = await page.evaluate(async () => {
        const mod = await import('/adapter-tauri.js');
        const result = await mod.default.send({ type: 'RECORDING_START' });
        return { result, seen: mod._testOnly.seenBarrierIds() };
      });

      // (1) The send reached the backend command it maps.
      const startCalls = await page.evaluate(() =>
        window.__TAURI__
          ._getInvokeCalls()
          .filter((call) => call.cmd === 'start_capture')
          .map((call) => call.args),
      );
      assert.deepEqual(sent.result, { ok: true });
      assert.equal(
        startCalls.length,
        1,
        `expected exactly one start_capture since the clear, got ${JSON.stringify(startCalls)}`,
      );

      // (2) ...and reset the reorder state on the way: the parked sentinel is gone.
      assert.ok(
        !sent.seen.includes(parkedBarrierId),
        `RECORDING_START should have cleared the parked sentinel, still held: ${JSON.stringify(sent.seen)}`,
      );
    } finally {
      await page.evaluate(async (ms) => {
        const mod = await import('/adapter-tauri.js');
        mod._testOnly.setBarrierWaitTimeout(ms);
      }, previousWindow);
    }
  });

  test('commit collects every delivered action into the step', async ({ page }) => {
    await openPanel(page, server);

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
    await fireCaptureActions(page, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        sequence_id: 1,
        element: { text: 'A' },
      },
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        sequence_id: 2,
        element: { text: 'B' },
      },
    ]);
    await page.waitForTimeout(100);

    // Now send the missing event (seq 3) after a short delay
    await fireCaptureActions(
      page,
      [
        {
          type: 'click',
          timestamp: Date.now(),
          capture_mode: 'accessibility',
          context_id: 1,
          sequence_id: 3,
          element: { text: 'C' },
        },
      ],
      { delayMs: 200 },
    );

    // Type narration and commit (commit uses commitWithCompleteness)
    await page.fill('#narration-input', 'All three events');
    await page.waitForTimeout(400); // let the panel settle the delivered actions
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
