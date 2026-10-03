/**
 * Desktop Panel UI Tests
 *
 * Tests the desktop panel by serving the built frontend against the suite's
 * shared `window.__TAURI__` mock (`tauri-mock-fixture.js`, which also documents
 * what the mock services). This validates DOM interactions and view transitions
 * without requiring the full Tauri runtime.
 */

import { test, expect } from './coverage-fixture.js';
import {
  clearInvokes,
  createProject,
  fireCaptureActions,
  installTauriMockServer,
  invokesOf,
  openPanel,
  seedRecordedStep,
  SUBMIT_CLICK,
} from './tauri-mock-fixture.js';
import assert from 'node:assert/strict';

const server = installTauriMockServer();

test.describe('Desktop Panel — Smoke', () => {
  test('panel loads and shows projects view', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('create project → project detail view', async ({ page }) => {
    await openPanel(page, server);

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Desktop Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Desktop Test');
  });

  test('create recording → recording view', async ({ page }) => {
    await openPanel(page, server);

    await createProject(page, 'P');

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#recording-title')).toHaveText('R');
  });
});

test.describe('Desktop Panel — Simple Mode', () => {
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
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await expect(page.locator('#simple-mode-box')).toBeVisible();
    await expect(page.locator('#narration-mode-box')).toBeHidden();
  });
});

test.describe('Desktop Panel — Metadata', () => {
  test('project metadata section exists and add button works', async ({ page }) => {
    await openPanel(page, server);

    await createProject(page, 'Meta');

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
    await createProject(page, 'Persist Test');

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

test.describe('Desktop Panel — Commit with Simulated Capture', () => {
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
    await seedRecordedStep(page, {
      project: 'Capture Test',
      recording: 'Rec',
      actions: null,
      narration: null,
    });

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

test.describe('Desktop Panel — Theme', () => {
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

test.describe('Desktop Panel — Narration Commit Flow', () => {
  test('type narration + simulated capture → commit → step appears', async ({ page }) => {
    await openPanel(page, server);

    // Create project + recording
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

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

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

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

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    // Type narration but no pending actions
    await page.fill('#narration-input', 'Some narration');
    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('narration input clears after commit', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

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

    // First step
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [
        { type: 'click', capture_mode: 'accessibility', context_id: 1, element: { text: 'A' } },
      ],
      narration: 'First',
    });

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

test.describe('Desktop Panel — Clear Button', () => {
  test('clear resets pending actions and disables commit', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

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

test.describe('Desktop Panel — Step Detail View', () => {
  test('clicking step narration opens detail view', async ({ page }) => {
    await openPanel(page, server);

    // Commit a step
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });

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

test.describe('Desktop Panel — Delete Step', () => {
  test('delete removes step from list', async ({ page }) => {
    await openPanel(page, server);

    // Commit two steps
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [
        { type: 'click', capture_mode: 'accessibility', context_id: 1, element: { text: 'A' } },
      ],
      narration: 'First',
    });
    await seedRecordedStep(page, {
      project: null,
      recording: null,
      actions: [
        { type: 'click', capture_mode: 'accessibility', context_id: 1, element: { text: 'B' } },
      ],
      narration: 'Second',
    });

    await expect(page.locator('.step-item')).toHaveCount(2);

    // Delete first step
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('#step-count')).toHaveText('1');
  });
});

test.describe('Desktop Panel — History View', () => {
  test('history button shows step versions', async ({ page }) => {
    await openPanel(page, server);

    // Commit a step
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Original',
    });

    // Click history
    await page.locator('[data-action="history"]').first().click();
    await page.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.history-item')).toHaveCount(1);

    // Back
    await page.click('#btn-history-back');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel — Projects View UI Elements', () => {
  test('file input is hidden', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#import-file-input')).toBeHidden();
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

test.describe('Desktop Panel — Project Detail UI', () => {
  test('export button is visible', async ({ page }) => {
    await openPanel(page, server);

    await createProject(page, 'P');

    await expect(page.locator('#btn-export-project')).toBeVisible();
  });

  test('recording list shows created recording', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    // Go back to project detail
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel — Recording View UI State', () => {
  test('pending actions section is hidden initially', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await expect(page.locator('#pending-actions-section')).toBeHidden();
  });

  test('recording badge shows Recording state after create', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });
});

test.describe('Desktop Panel — Breadcrumb Navigation', () => {
  test('breadcrumb navigates back to projects list', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('breadcrumb project link navigates to project detail', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-project')).toBeVisible();
  });
});

test.describe('Desktop Panel — Settings Additional', () => {
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

test.describe('Desktop Panel — Delete Project', () => {
  test('delete removes project from list', async ({ page }) => {
    await openPanel(page, server);

    await createProject(page, 'To Delete');

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

test.describe('Desktop Panel — Re-record Flow', () => {
  test('re-record opens recording view with banner', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Original step',
    });

    // Click edit/re-record on the step
    await page.locator('[data-action="edit"]').first().click();
    await page.waitForTimeout(500);

    // Should show re-record banner
    await expect(page.locator('#rerecord-banner')).toBeVisible();
  });
});

test.describe('Desktop Panel — Toggle Recording', () => {
  test('pause and resume recording toggles state', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, { project: 'P', recording: 'R', actions: null, narration: null });

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

test.describe('Desktop Panel — Recording Delete', () => {
  test('delete recording removes it from project view', async ({ page }) => {
    await openPanel(page, server);

    await createProject(page, 'P');

    await seedRecordedStep(page, {
      project: null,
      recording: 'Rec A',
      actions: null,
      narration: null,
    });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await seedRecordedStep(page, {
      project: null,
      recording: 'Rec B',
      actions: null,
      narration: null,
    });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.card-item')).toHaveCount(2);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.card-item')).toHaveCount(1);
  });

  test('delete recording returns to project view', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'To Delete',
      actions: null,
      narration: null,
    });

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

test.describe('Desktop Panel — Window Target Selector', () => {
  test('target app dropdown is visible in recording view', async ({ page }) => {
    await openPanel(page, server);

    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: null,
      narration: null,
    });

    await expect(page.locator('#target-app-select')).toBeVisible();
  });
});

test.describe('Desktop Panel — Adapter Capture Lifecycle', () => {
  test('RECORDING_START invokes start_capture and resets reorder state', async ({ page }) => {
    await openPanel(page, server);

    // Create project + recording to get to recording view
    await seedRecordedStep(page, {
      project: 'Capture Lifecycle',
      recording: 'R',
      actions: null,
      narration: null,
    });

    // The recording-create path starts capture by a direct invoke, so clear the
    // record first: what this test reads afterwards is the seam route's own
    // start_capture and nothing else.
    await clearInvokes(page);

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
      const startCalls = (await invokesOf(page, 'start_capture')).map((call) => call.args);
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

    await seedRecordedStep(page, {
      project: 'Completeness',
      recording: 'R',
      actions: null,
      narration: null,
    });

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
