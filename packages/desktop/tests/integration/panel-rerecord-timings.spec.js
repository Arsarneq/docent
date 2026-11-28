/**
 * Desktop Panel — a re-record thrown away throws its capture timings away
 *
 * The capture timings' block is written when a capture stops. A take the
 * panel throws away is hidden by the recording, so its timings go with it:
 * leaving a re-record and cancelling one ask the backend to throw the
 * timings away, through `stop_capture`'s `discardTimings` where the take's
 * capture stops, and through `discard_capture_timings` where the capture
 * keeps running. Every other stop keeps them.
 */

import { test, expect } from './coverage-fixture.js';
import {
  installTauriMockServer,
  openPanel,
  seedRecordedStep,
  invokesOf,
  clearInvokes,
} from './tauri-mock-fixture.js';

const server = installTauriMockServer();

const CLICK = {
  type: 'click',
  capture_mode: 'accessibility',
  context_id: 1,
  element: { text: 'a', tag: 'Button', selector: '#btn' },
};

/** A recording with one committed step, capturing again after the commit. */
async function recordingWithAStep(page) {
  await openPanel(page, server);
  await seedRecordedStep(page, { project: 'P', recording: 'R', actions: [CLICK], narration: 'a' });
  await expect(page.locator('#recording-badge')).toContainText('Recording');
}

async function openRerecord(page) {
  await page.locator('[data-action="edit"]').first().click();
  await expect(page.locator('#rerecord-banner')).toBeVisible();
}

const discarding = (stops) => stops.map((stop) => stop.args?.discardTimings === true);

test.describe('Desktop Panel — capture timings of a re-record thrown away', () => {
  test('leaving a re-record stops its capture throwing the timings away', async ({ page }) => {
    await recordingWithAStep(page);
    await openRerecord(page);
    await clearInvokes(page);

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)');

    expect(discarding(await invokesOf(page, 'stop_capture'))).toEqual([true]);
  });

  test('cancelling a re-record opened while paused stops its capture throwing the timings away', async ({
    page,
  }) => {
    await recordingWithAStep(page);
    await page.click('#btn-toggle-recording');
    await expect(page.locator('#recording-badge')).toContainText('Paused');
    await openRerecord(page);
    await clearInvokes(page);

    await page.click('#btn-rerecord-cancel');
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    expect(discarding(await invokesOf(page, 'stop_capture'))).toEqual([true]);
  });

  test('cancelling a re-record opened while recording throws the timings away and keeps capturing', async ({
    page,
  }) => {
    await recordingWithAStep(page);
    await openRerecord(page);
    await clearInvokes(page);

    await page.click('#btn-rerecord-cancel');
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    expect(await invokesOf(page, 'discard_capture_timings')).toHaveLength(1);
    expect(await invokesOf(page, 'stop_capture')).toEqual([]);
    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });

  test('Pause and a commit keep the timings', async ({ page }) => {
    await recordingWithAStep(page);
    await clearInvokes(page);

    await page.click('#btn-toggle-recording');
    await expect(page.locator('#recording-badge')).toContainText('Paused');
    await page.click('#btn-toggle-recording');
    await expect(page.locator('#recording-badge')).toContainText('Recording');
    await seedRecordedStep(page, {
      project: null,
      recording: null,
      actions: [CLICK],
      narration: 'b',
    });

    const stops = await invokesOf(page, 'stop_capture');
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(discarding(stops).every((d) => !d)).toBe(true);
    expect(await invokesOf(page, 'discard_capture_timings')).toEqual([]);
  });
});
