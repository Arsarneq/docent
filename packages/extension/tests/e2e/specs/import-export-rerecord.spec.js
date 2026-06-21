/**
 * E2E Tests — Import, Export, Re-record, and Drag Reorder
 *
 * Covers the remaining flows from issue #30:
 * - Import: select .docent.json file → project appears in list
 * - Export: click export → download intercepted → valid JSON
 * - Re-record: edit step → new actions → commit → version updated
 * - Drag reorder: move step → verify step_number changes persist
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
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
      acceptDownloads: true,
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

async function createProjectWithStep(panelPage, serviceWorker) {
  await panelPage.click('#btn-new-project');
  await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-project-name', 'Export Test');
  await panelPage.click('#btn-new-project-create');
  await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await panelPage.click('#btn-new-recording');
  await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await panelPage.fill('#new-recording-name', 'Flow A');
  await panelPage.click('#btn-new-recording-create');
  await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  // Commit a step
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      pendingActions: [
        { type: 'click', timestamp: Date.now(), element: { text: 'Login', selector: '#btn' } },
      ],
      pendingCount: 1,
    });
  });
  await panelPage.waitForTimeout(300);
  await panelPage.fill('#narration-input', 'Click the login button');
  await panelPage.click('#btn-commit-step');
  await panelPage.waitForTimeout(500);
}

// ─── Import Flow ──────────────────────────────────────────────────────────────

test.describe('Import Flow', () => {
  test('importing a .docent.json file adds project to list', async ({ panelPage }) => {
    // Create a valid .docent.json file
    const importData = {
      docent_format: { platform: 'extension', schema_version: '3.0.0' },
      project: {
        project_id: '019e0000-0000-7000-8000-000000000001',
        name: 'Imported Project',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [
        {
          recording_id: '019e0000-0000-7000-8000-000000000002',
          name: 'Imported Recording',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [
            {
              uuid: '019e0000-0000-7000-8000-000000000003',
              logical_id: '019e0000-0000-7000-8000-000000000004',
              step_number: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              narration: 'Imported step',
              narration_source: 'typed',
              actions: [
                {
                  type: 'click',
                  timestamp: 1000,
                  capture_mode: 'dom',
                  context_id: 1,
                  frame_src: null,
                  x: 10,
                  y: 20,
                  element: {
                    tag: 'BUTTON',
                    id: null,
                    name: null,
                    role: null,
                    type: null,
                    text: 'OK',
                    selector: 'button',
                  },
                },
              ],
              deleted: false,
            },
          ],
        },
      ],
    };

    const tmpFile = path.join(__dirname, 'test-import.docent.json');
    fs.writeFileSync(tmpFile, JSON.stringify(importData));

    try {
      // Trigger file chooser and select the file
      const [fileChooser] = await Promise.all([
        panelPage.waitForEvent('filechooser'),
        panelPage.click('#btn-import-project'),
      ]);
      await fileChooser.setFiles(tmpFile);
      await panelPage.waitForTimeout(500);

      // Project should appear in the list
      await expect(panelPage.locator('.card-item')).toHaveCount(1);
      await expect(panelPage.locator('.card-item-name')).toContainText('Imported Project');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ─── Export Flow ──────────────────────────────────────────────────────────────

test.describe('Export Flow', () => {
  test('export produces valid .docent.json download', async ({
    panelPage,
    serviceWorker,
    context,
  }) => {
    await createProjectWithStep(panelPage, serviceWorker);

    // Go to project view
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Click export and intercept the download
    const [download] = await Promise.all([
      panelPage.waitForEvent('download'),
      panelPage.click('#btn-export-project'),
    ]);

    // Verify the download
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.docent\.json$/);

    // Read and validate the content
    const filePath = await download.path();
    const content = fs.readFileSync(filePath, 'utf-8');
    const exported = JSON.parse(content);

    // Validate structure
    expect(exported.project).toBeDefined();
    expect(exported.project.name).toBe('Export Test');
    expect(exported.recordings).toHaveLength(1);
    expect(exported.recordings[0].name).toBe('Flow A');
    expect(exported.recordings[0].steps).toHaveLength(1);
    expect(exported.recordings[0].steps[0].narration).toBe('Click the login button');
    expect(exported.recordings[0].steps[0].actions).toHaveLength(1);
  });
});

// ─── Re-record Flow ───────────────────────────────────────────────────────────

test.describe('Re-record Flow', () => {
  test('edit step → new actions → commit → narration updated', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProjectWithStep(panelPage, serviceWorker);

    // Verify initial step
    await expect(panelPage.locator('.step-narration')).toContainText('Click the login button');

    // Click edit (re-record) on the step
    await panelPage.locator('[data-action="edit"]').first().click();
    await panelPage.waitForTimeout(500);

    // Should show re-record banner
    await expect(panelPage.locator('#rerecord-banner')).toBeVisible();

    // Simulate new pending actions for the re-record
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [
          {
            type: 'type',
            timestamp: Date.now(),
            element: { selector: '#email' },
            value: 'new@test.com',
          },
        ],
        pendingCount: 1,
      });
    });
    await panelPage.waitForTimeout(300);

    // Update narration and commit
    await panelPage.fill('#narration-input', 'Updated: type email address');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(500);

    // Re-record banner should be hidden
    await expect(panelPage.locator('#rerecord-banner')).toBeHidden();

    // Step narration should be updated
    await expect(panelPage.locator('.step-narration')).toContainText('Updated: type email address');

    // Still only 1 step (re-record replaces, doesn't add)
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
  });
});

// ─── Drag Reorder Flow ────────────────────────────────────────────────────────

test.describe('Drag Reorder Flow', () => {
  test('drag step to new position → order persists after navigation', async ({
    panelPage,
    serviceWorker,
  }) => {
    // Create project with recording
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Reorder Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit 3 steps
    for (const label of ['First', 'Second', 'Third']) {
      await serviceWorker.evaluate(async () => {
        await chrome.storage.local.set({
          pendingActions: [{ type: 'click', timestamp: Date.now() }],
          pendingCount: 1,
        });
      });
      await panelPage.waitForTimeout(300);
      await panelPage.fill('#narration-input', label);
      await panelPage.click('#btn-commit-step');
      await panelPage.waitForTimeout(500);
    }

    // Verify initial order
    const steps = panelPage.locator('.step-narration');
    await expect(steps.nth(0)).toContainText('First');
    await expect(steps.nth(1)).toContainText('Second');
    await expect(steps.nth(2)).toContainText('Third');

    // Drag the third step to the first position
    const thirdStep = panelPage.locator('.step-item').nth(2);
    const firstStep = panelPage.locator('.step-item').nth(0);
    await thirdStep.dragTo(firstStep);
    await panelPage.waitForTimeout(500);

    // Verify new order after drag
    await expect(steps.nth(0)).toContainText('Third');
    await expect(steps.nth(1)).toContainText('First');
    await expect(steps.nth(2)).toContainText('Second');

    // Navigate away and back to verify persistence
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await panelPage.click('[data-action="open"]');
    await panelPage.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Order should persist
    const stepsAfter = panelPage.locator('.step-narration');
    await expect(stepsAfter.nth(0)).toContainText('Third');
    await expect(stepsAfter.nth(1)).toContainText('First');
    await expect(stepsAfter.nth(2)).toContainText('Second');
  });
});
