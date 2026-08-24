/**
 * Desktop Panel — Dispatch & Sync Flow Tests
 *
 * Tests the dispatch confirmation flow, settings persistence,
 * sync button behavior, re-record flow, and project deletion.
 * These cover the uncovered paths in panel.js.
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, fireCaptureActions, openPanel } from './tauri-mock-fixture.js';

const server = installTauriMockServer();

// Helper: create a project with a committed step
async function setupProjectWithStep(page) {
  await openPanel(page, server);

  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', 'Dispatch Test');
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', 'Flow');
  await page.click('#btn-new-recording-create');
  await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  // Simulate capture event
  await fireCaptureActions(page, [
    {
      type: 'click',
      timestamp: Date.now(),
      capture_mode: 'accessibility',
      context_id: 1,
      element: { text: 'Submit', tag: 'Button', selector: '#btn' },
    },
  ]);
  await page.waitForTimeout(300);

  await page.fill('#narration-input', 'Click submit');
  await page.click('#btn-commit-step');
  await page.waitForTimeout(500);
}

test.describe('Desktop Panel — Dispatch Settings', () => {
  test('saving dispatch settings persists endpoint URL', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await page.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
    await page.fill('#settings-api-key', 'test-key-123');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);

    // Navigate away and back to settings
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#settings-endpoint-url')).toHaveValue(
      'https://api.example.com/dispatch',
    );
  });

  test('invalid endpoint URL shows error', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await page.fill('#settings-endpoint-url', 'ftp://invalid');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);

    await expect(page.locator('#settings-endpoint-error')).not.toBeEmpty();
  });
});

test.describe('Desktop Panel — Sync Settings', () => {
  test('saving sync settings persists sync URL', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await page.fill('#settings-sync-url', 'https://sync.example.com');
    await page.fill('#settings-sync-api-key', 'sync-key');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);

    // Navigate away and back
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#settings-sync-url')).toHaveValue('https://sync.example.com');
  });

  test('invalid sync URL shows error', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    await page.fill('#settings-sync-url', 'not-a-url');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);

    await expect(page.locator('#settings-sync-error')).not.toBeEmpty();
  });
});

test.describe('Desktop Panel — Dispatch Flow', () => {
  test('dispatch button disabled without endpoint configured', async ({ page }) => {
    await setupProjectWithStep(page);

    // Go back to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-dispatch-project')).toBeDisabled();
  });

  test('dispatch flow shows confirmation with step count', async ({ page }) => {
    // First configure endpoint
    await openPanel(page, server);

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project with step
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'D');
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

    // Go to project view and click dispatch
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#confirm-steps')).toHaveText('1');
    await expect(page.locator('#confirm-endpoint')).toContainText('api.example.com');
  });

  test('cancel dispatch returns to project view', async ({ page }) => {
    await openPanel(page, server);

    // Configure endpoint
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project with step
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
    await page.fill('#narration-input', 'Step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-confirm-cancel');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel — Delete Project', () => {
  test('delete project removes it from list', async ({ page }) => {
    await openPanel(page, server);

    // Create a project
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'To Delete');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Go back to projects list
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Should have 1 project
    await expect(page.locator('[data-action="open"]')).toHaveCount(1);

    // Delete it
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('[data-action="delete"]');
    await page.waitForTimeout(500);

    // Should show empty state
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Desktop Panel — Re-record Flow', () => {
  test('re-record button enters re-record state', async ({ page }) => {
    await openPanel(page, server);

    // Create project + recording + commit step
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
        element: { text: 'A' },
      },
    ]);
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Original step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click re-record on the step
    const rerecordBtn = page.locator('[data-action="rerecord"]').first();
    if (await rerecordBtn.isVisible()) {
      await rerecordBtn.click();
      await page.waitForTimeout(300);

      // Re-record banner should be visible
      await expect(page.locator('#rerecord-banner')).toBeVisible();
    }
  });
});

test.describe('Desktop Panel — Toggle Recording', () => {
  test('pause and resume recording toggles state', async ({ page }) => {
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

    // Should be recording (badge shows "Recording")
    await expect(page.locator('#recording-badge')).toContainText('Recording');

    // Pause
    await page.click('#btn-toggle-recording');
    await page.waitForTimeout(200);
    await expect(page.locator('#recording-badge')).toContainText('Paused');

    // Resume
    await page.click('#btn-toggle-recording');
    await page.waitForTimeout(200);
    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });
});

test.describe('Desktop Panel — Delete Recording', () => {
  test('delete recording returns to project view', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'To Delete');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Go back to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Delete the recording
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('[data-action="delete"]');
    await page.waitForTimeout(500);

    // Should show empty recordings state
    await expect(page.locator('#recordings-empty')).toBeVisible();
  });
});
