/**
 * Desktop Panel — confirmation dialogs
 *
 * In the shipped app the dialog plugin replaces `window.confirm` with an async
 * function, so a confirmation answers with a Promise of the user's choice; the
 * suite's mock mirrors that shape (`tauri-mock-fixture.js`). These specs answer
 * each destructive confirmation with Cancel and hold that nothing was cleared or
 * deleted, and answer it with OK where no other spec does.
 */

import { test, expect } from './coverage-fixture.js';
import {
  createProject,
  fireCaptureActions,
  installTauriMockServer,
  openPanel,
  seedRecordedStep,
  SUBMIT_CLICK,
} from './tauri-mock-fixture.js';

const server = installTauriMockServer();

/** Answers the next dialog the page opens, and resolves with what it showed. */
function answerNextDialog(page, accept) {
  return new Promise((resolve) => {
    page.once('dialog', async (dialog) => {
      const shown = { type: dialog.type(), message: dialog.message() };
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      resolve(shown);
    });
  });
}

/** Lets the click handler finish whatever it does after the dialog answers. */
async function settle(page) {
  await page.waitForTimeout(500);
}

async function switchToSimpleMode(page) {
  await page.click('#btn-settings');
  await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
  const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
  await simpleLabel.scrollIntoViewIfNeeded();
  await simpleLabel.click();
  await page.click('#btn-settings-back');
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
}

async function recordPendingClick(page) {
  await fireCaptureActions(page, [
    {
      type: 'click',
      timestamp: Date.now(),
      capture_mode: 'accessibility',
      context_id: 1,
      element: { text: 'X' },
    },
  ]);
  await expect(page.locator('#pending-action-count')).toHaveText('1');
}

test.describe('Desktop Panel — the mock confirm', () => {
  test('answers with a Promise of the choice, as the dialog plugin does', async ({ page }) => {
    await openPanel(page, server);

    const shown = answerNextDialog(page, false);
    const result = await page.evaluate(() => {
      const answer = window.confirm('Probe?');
      return answer instanceof Promise
        ? answer.then((v) => ({ promise: true, v }))
        : { promise: false, v: answer };
    });

    expect(await shown).toEqual({ type: 'confirm', message: 'Probe?' });
    expect(result).toEqual({ promise: true, v: false });
  });
});

test.describe('Desktop Panel — Cancel keeps what the confirmation guards', () => {
  test('Clear, answered Cancel, keeps the pending actions', async ({ page }) => {
    await openPanel(page, server);
    await seedRecordedStep(page, { project: 'P', recording: 'R', actions: null, narration: null });
    await recordPendingClick(page);
    await page.fill('#narration-input', 'Something');
    await expect(page.locator('#btn-commit-step')).toBeEnabled();

    const shown = answerNextDialog(page, false);
    await page.click('#btn-clear-step');
    expect(await shown).toEqual({
      type: 'confirm',
      message: 'Clear all recorded actions for this step?',
    });
    await settle(page);

    await expect(page.locator('#pending-action-count')).toHaveText('1');
    await expect(page.locator('#pending-action-list > *')).toHaveCount(1);
    await expect(page.locator('#btn-commit-step')).toBeEnabled();
  });

  test('Clear in simple mode, answered Cancel, keeps the pending actions', async ({ page }) => {
    await openPanel(page, server);
    await switchToSimpleMode(page);
    await seedRecordedStep(page, { project: 'P', recording: 'R', actions: null, narration: null });
    await recordPendingClick(page);
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();

    const shown = answerNextDialog(page, false);
    await page.click('#btn-clear-step-simple');
    expect(await shown).toEqual({
      type: 'confirm',
      message: 'Clear all recorded actions for this step?',
    });
    await settle(page);

    await expect(page.locator('#pending-action-count')).toHaveText('1');
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();
  });

  test('Delete step, answered Cancel, keeps the step', async ({ page }) => {
    await openPanel(page, server);
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });
    await expect(page.locator('.step-item')).toHaveCount(1);

    const shown = answerNextDialog(page, false);
    await page.locator('[data-action="delete"]').first().click();
    expect(await shown).toEqual({
      type: 'confirm',
      message: 'Delete this step? History will be preserved.',
    });
    await settle(page);

    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('#step-count')).toHaveText('1');
  });

  test('Delete recording, answered Cancel, keeps the recording', async ({ page }) => {
    await openPanel(page, server);
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'Keep me',
      actions: null,
      narration: null,
    });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);

    const shown = answerNextDialog(page, false);
    await page.locator('[data-action="delete"]').first().click();
    expect(await shown).toEqual({
      type: 'confirm',
      message: 'Delete recording "Keep me"? This cannot be undone.',
    });
    await settle(page);

    await expect(page.locator('.card-item')).toHaveCount(1);
    await expect(page.locator('#view-project')).toBeVisible();
  });

  test('Delete project, answered Cancel, keeps the project', async ({ page }) => {
    await openPanel(page, server);
    await createProject(page, 'Keep me');
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);

    const shown = answerNextDialog(page, false);
    await page.locator('[data-action="delete"]').first().click();
    expect(await shown).toEqual({
      type: 'confirm',
      message: 'Delete project "Keep me"? This cannot be undone.',
    });
    await settle(page);

    await expect(page.locator('.card-item')).toHaveCount(1);
    await expect(page.locator('#projects-empty')).toBeHidden();
  });
});

test.describe('Desktop Panel — OK goes ahead', () => {
  test('Clear in simple mode, answered OK, clears the pending actions', async ({ page }) => {
    await openPanel(page, server);
    await switchToSimpleMode(page);
    await seedRecordedStep(page, { project: 'P', recording: 'R', actions: null, narration: null });
    await recordPendingClick(page);

    const shown = answerNextDialog(page, true);
    await page.click('#btn-clear-step-simple');
    await shown;

    await expect(page.locator('#pending-action-count')).toHaveText('0');
    await expect(page.locator('#btn-commit-step-simple')).toBeDisabled();
  });
});
