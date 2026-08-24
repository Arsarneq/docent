/**
 * Desktop E2E Tests — Import, Export, Re-record, and Drag Reorder
 *
 * Covers the desktop side of issue #30:
 * - Import: invoke('import_file') returns JSON → project appears in list
 * - Export: invoke('export_file') called with valid JSON
 * - Re-record: edit step → new actions → commit → narration updated
 * - Drag reorder: move step → verify step_number changes persist
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, fireCaptureActions, openPanel } from './tauri-mock-fixture.js';
import { composePlatform } from '../../../../scripts/build-schemas.js';
import { stampFromSchema } from '../../../../packages/shared/lib/format-stamp.js';

// Derive the docent_format stamp from the current composed schema rather than
// hardcoding a version. Import validates the stamp against the schema_version
// `const`, so a hardcoded version breaks on every schema bump — deriving it
// means these fixtures need ZERO edits when the schema version changes.
const DESKTOP_STAMP = stampFromSchema(composePlatform('desktop-windows'));

const server = installTauriMockServer();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createProjectWithStep(page) {
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', 'Export Test');
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', 'Flow A');
  await page.click('#btn-new-recording-create');
  await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  // Simulate a capture event and commit
  await fireCaptureActions(page, [
    {
      type: 'click',
      timestamp: Date.now(),
      capture_mode: 'accessibility',
      context_id: 1,
      element: { text: 'Login', tag: 'Button', selector: '#btn' },
    },
  ]);
  await page.waitForTimeout(300);
  await page.fill('#narration-input', 'Click the login button');
  await page.click('#btn-commit-step');
  await page.waitForTimeout(500);
}

// ─── Import Flow ──────────────────────────────────────────────────────────────

test.describe('Desktop Import Flow', () => {
  test('importing via native dialog adds project to list', async ({ page }) => {
    await openPanel(page, server);

    // Set up the mock to return a valid import JSON
    const importData = {
      docent_format: DESKTOP_STAMP,
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
                  capture_mode: 'accessibility',
                  context_id: 1,
                  x: 10,
                  y: 20,
                  element: {
                    tag: 'Button',
                    id: null,
                    name: null,
                    role: null,
                    type: null,
                    text: 'OK',
                    selector: 'OK',
                  },
                },
              ],
              deleted: false,
            },
          ],
        },
      ],
    };

    await page.evaluate((data) => {
      window.__TAURI__._setImportResult(JSON.stringify(data));
    }, importData);

    // Click import
    await page.click('#btn-import-project');
    await page.waitForTimeout(500);

    // Project should appear in the list
    await expect(page.locator('.card-item')).toHaveCount(1);
    await expect(page.locator('.card-item-name')).toContainText('Imported Project');
  });
});

// ─── Export Flow ──────────────────────────────────────────────────────────────

test.describe('Desktop Export Flow', () => {
  test('export calls invoke with valid JSON', async ({ page }) => {
    await openPanel(page, server);
    await createProjectWithStep(page);

    // Go to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Click export
    await page.click('#btn-export-project');
    await page.waitForTimeout(500);

    // Check what was exported via the mock
    const lastExport = await page.evaluate(() => window.__TAURI__._getLastExport());

    expect(lastExport).not.toBeNull();
    expect(lastExport.defaultName).toMatch(/\.docent\.json$/);

    const exported = JSON.parse(lastExport.data);
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

test.describe('Desktop Re-record Flow', () => {
  test('edit step → new actions → commit → narration updated', async ({ page }) => {
    await openPanel(page, server);
    await createProjectWithStep(page);

    // Verify initial step
    await expect(page.locator('.step-narration')).toContainText('Click the login button');

    // Click edit (re-record) on the step
    await page.locator('[data-action="edit"]').first().click();
    await page.waitForTimeout(500);

    // Should show re-record banner
    await expect(page.locator('#rerecord-banner')).toBeVisible();

    // Simulate new capture event for the re-record
    await fireCaptureActions(page, [
      {
        type: 'type',
        timestamp: Date.now(),
        capture_mode: 'accessibility',
        context_id: 1,
        element: { selector: '#email', tag: 'Input' },
        value: 'new@test.com',
      },
    ]);
    await page.waitForTimeout(300);

    // Update narration and commit
    await page.fill('#narration-input', 'Updated: type email address');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Re-record banner should be hidden
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    // Step narration should be updated
    await expect(page.locator('.step-narration')).toContainText('Updated: type email address');

    // Still only 1 step (re-record replaces, doesn't add)
    await expect(page.locator('.step-item')).toHaveCount(1);
  });
});

// ─── Drag Reorder Flow ────────────────────────────────────────────────────────

test.describe('Desktop Drag Reorder Flow', () => {
  test('drag step to new position → order persists after navigation', async ({ page }) => {
    await openPanel(page, server);

    // Create project with recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Reorder Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit 3 steps
    for (const label of ['First', 'Second', 'Third']) {
      await fireCaptureActions(page, [
        {
          type: 'click',
          timestamp: Date.now(),
          capture_mode: 'accessibility',
          context_id: 1,
          element: { text: label, tag: 'Button' },
        },
      ]);
      await page.waitForTimeout(300);
      await page.fill('#narration-input', label);
      await page.click('#btn-commit-step');
      await page.waitForTimeout(500);
    }

    // Verify initial order
    const steps = page.locator('.step-narration');
    await expect(steps.nth(0)).toContainText('First');
    await expect(steps.nth(1)).toContainText('Second');
    await expect(steps.nth(2)).toContainText('Third');

    // Drag the third step to the first position
    const thirdStep = page.locator('.step-item').nth(2);
    const firstStep = page.locator('.step-item').nth(0);
    await thirdStep.dragTo(firstStep);
    await page.waitForTimeout(500);

    // Verify new order after drag
    await expect(steps.nth(0)).toContainText('Third');
    await expect(steps.nth(1)).toContainText('First');
    await expect(steps.nth(2)).toContainText('Second');

    // Navigate away and back to verify persistence
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Order should persist
    const stepsAfter = page.locator('.step-narration');
    await expect(stepsAfter.nth(0)).toContainText('Third');
    await expect(stepsAfter.nth(1)).toContainText('First');
    await expect(stepsAfter.nth(2)).toContainText('Second');
  });
});
