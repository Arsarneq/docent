/**
 * Desktop Panel: no capture timings are measured while a re-record is open
 *
 * A re-record's take is hidden by the recording, so its capture measures no
 * timings. The panel tells the backend through `set_capture_timings_measuring`
 * not to measure as a re-record opens, and to measure again before each start
 * of a capture that is not a re-record's, and as a re-record cancelled while it
 * records leaves its capture running. Each spec reads the panel's command
 * traffic as a trace: every start and stop of the capture, stamped with
 * whether the panel had last told the backend to measure.
 */

import { test, expect } from './coverage-fixture.js';
import {
  installTauriMockServer,
  openPanel,
  seedRecordedStep,
  invokedCommands,
  invokesOf,
} from './tauri-mock-fixture.js';

const server = installTauriMockServer();

const CLICK = {
  type: 'click',
  capture_mode: 'accessibility',
  context_id: 1,
  element: { text: 'a', tag: 'Button', selector: '#btn' },
};

/**
 * Every start and stop of the capture, in order, as `start` or `stop` with
 * `on` where the panel had last told the backend to measure (the backend
 * measures until told otherwise) and `held` where it had told it not to.
 * Also returns whether it measures at the end.
 */
async function trace(page) {
  const told = (await invokesOf(page, 'set_capture_timings_measuring')).map(
    ({ args }) => args.measuring,
  );
  let measuring = true;
  const steps = [];
  for (const cmd of await invokedCommands(page)) {
    if (cmd === 'set_capture_timings_measuring') measuring = told.shift();
    if (cmd === 'start_capture') steps.push(`start ${measuring ? 'on' : 'held'}`);
    if (cmd === 'stop_capture') steps.push(`stop ${measuring ? 'on' : 'held'}`);
  }
  return { steps, measuring };
}

/** The trace's starts and stops after the first `from` of them. */
async function stepsSince(page, from) {
  return (await trace(page)).steps.slice(from);
}

/** A recording with one committed step, capturing again after the commit. */
async function recordingWithAStep(page) {
  await openPanel(page, server);
  await seedRecordedStep(page, { project: 'P', recording: 'R', actions: [CLICK], narration: 'a' });
  await expect(page.locator('#recording-badge')).toContainText('Recording');
  return (await trace(page)).steps.length;
}

async function openRerecord(page) {
  await page.locator('[data-action="edit"]').first().click();
  await expect(page.locator('#rerecord-banner')).toBeVisible();
}

async function togglePause(page, badge) {
  await page.click('#btn-toggle-recording');
  await expect(page.locator('#recording-badge')).toContainText(badge);
}

/** A new recording in the open project, which starts a plain capture. */
async function newRecording(page) {
  await page.click('#bc-project');
  await page.waitForSelector('#view-project:not(.hidden)');
  await seedRecordedStep(page, { project: null, recording: 'R2', actions: null, narration: null });
}

async function openSettings(page) {
  await page.click('#btn-settings');
  await page.waitForSelector('#view-settings:not(.hidden)');
}

async function closeSettings(page) {
  await page.click('#btn-settings-back');
  await page.waitForSelector('#view-projects:not(.hidden)');
}

test.describe('Desktop Panel: capture timings while a re-record is open', () => {
  test('the recording before a re-record is measured, and its take is held from its start', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    expect((await trace(page)).steps).toEqual(['start on', 'stop on', 'start on']);

    await openRerecord(page);

    expect(await stepsSince(page, from)).toEqual(['stop on', 'start held']);
  });

  test('a re-record opened while paused starts its capture held', async ({ page }) => {
    const from = await recordingWithAStep(page);
    await togglePause(page, 'Paused');

    await openRerecord(page);

    expect(await stepsSince(page, from)).toEqual(['stop on', 'start held']);
  });

  test('a re-record paused and left measures nothing of its take, and the next recording is measured', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await openRerecord(page);
    await togglePause(page, 'Paused');

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)');
    await seedRecordedStep(page, {
      project: null,
      recording: 'R2',
      actions: null,
      narration: null,
    });

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a re-record left while recording stops its take held, and the next recording is measured', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await openRerecord(page);

    await newRecording(page);

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a re-record paused and cancelled measures nothing of its take, and the recording resumed is measured', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await openRerecord(page);
    await togglePause(page, 'Paused');

    await page.click('#btn-rerecord-cancel');
    await expect(page.locator('#rerecord-banner')).toBeHidden();
    await togglePause(page, 'Recording');

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a re-record opened while paused and cancelled stops its take held, and the recording resumed is measured', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await togglePause(page, 'Paused');
    await openRerecord(page);

    await page.click('#btn-rerecord-cancel');
    await expect(page.locator('#rerecord-banner')).toBeHidden();
    await togglePause(page, 'Recording');

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a re-record cancelled while recording keeps its capture running and measuring again', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await openRerecord(page);

    await page.click('#btn-rerecord-cancel');
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    expect(await stepsSince(page, from)).toEqual(['stop on', 'start held']);
    expect((await trace(page)).measuring).toBe(true);
    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });

  test('a committed re-record stops its take held, and the recording after it is measured', async ({
    page,
  }) => {
    const from = await recordingWithAStep(page);
    await openRerecord(page);
    await seedRecordedStep(page, {
      project: null,
      recording: null,
      actions: [CLICK],
      narration: null,
    });

    await page.fill('#narration-input', 'a again');
    await page.click('#btn-commit-step');
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a committed re-record in simple mode stops its take held, and the recording after it is measured', async ({
    page,
  }) => {
    await openPanel(page, server);
    await openSettings(page);
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await closeSettings(page);
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [CLICK],
      narration: null,
    });
    await page.click('#btn-commit-step-simple');
    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('#recording-badge')).toContainText('Recording');
    const from = (await trace(page)).steps.length;

    await openRerecord(page);
    await seedRecordedStep(page, {
      project: null,
      recording: null,
      actions: [CLICK],
      narration: null,
    });
    await page.click('#btn-commit-step-simple');
    await expect(page.locator('#rerecord-banner')).toBeHidden();
    await expect(page.locator('#recording-badge')).toContainText('Recording');

    expect(await stepsSince(page, from)).toEqual([
      'stop on',
      'start held',
      'stop held',
      'start on',
    ]);
  });

  test('a sync that ends while a re-record records leaves its take held to the next recording', async ({
    page,
  }) => {
    await openPanel(page, server);
    await openSettings(page);
    await page.fill('#settings-sync-url', 'https://sync.example.com');
    await page.fill('#settings-sync-api-key', 'sync-key');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(200);
    await closeSettings(page);
    await page.evaluate(() => {
      window.fetch = async (url, opts) => {
        if (url.endsWith('/projects') && (!opts || opts.method === 'GET'))
          return { ok: true, status: 200, json: async () => [] };
        return { ok: true, status: 200, json: async () => ({}) };
      };
    });
    page.on('dialog', (dialog) => dialog.accept());
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [CLICK],
      narration: 'a',
    });
    await expect(page.locator('#recording-badge')).toContainText('Recording');
    const from = (await trace(page)).steps.length;
    await openRerecord(page);

    // The Sync handler does not look at the view: a sync that ends now shows
    // the projects list, which ends the re-record without stopping its take.
    await page.evaluate(() => document.getElementById('btn-sync').click());
    await page.waitForSelector('#view-projects:not(.hidden)');
    await expect(page.locator('#btn-sync')).toHaveText('Sync');

    expect(await stepsSince(page, from)).toEqual(['stop on', 'start held']);
    expect((await trace(page)).measuring).toBe(false);

    await page.locator('[data-action="open"]').first().click();
    await page.waitForSelector('#view-project:not(.hidden)');
    await seedRecordedStep(page, {
      project: null,
      recording: 'R2',
      actions: null,
      narration: null,
    });

    // The capture that path leaves running is not this spec's: the next start
    // of a capture that is not a re-record's measures, whatever it finds.
    const after = await trace(page);
    expect(after.steps.at(-1)).toBe('start on');
    expect(after.measuring).toBe(true);
  });

  test('Pause and a commit of a plain recording are measured', async ({ page }) => {
    const from = await recordingWithAStep(page);

    await togglePause(page, 'Paused');
    await togglePause(page, 'Recording');
    await seedRecordedStep(page, {
      project: null,
      recording: null,
      actions: [CLICK],
      narration: 'b',
    });

    expect(await stepsSince(page, from)).toEqual(['stop on', 'start on', 'stop on', 'start on']);
  });
});
