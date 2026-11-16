/**
 * Desktop E2E — leaving a re-record discards what its capture stop drains
 *
 * Every capture stop drains the backend's held actions, and those action
 * events travel apart from the stop command's result with no ordering between
 * them (DCP-2). So an action the re-record captured can reach the panel AFTER
 * `stop_capture` has answered. This spec's `stop_capture` models that: it
 * answers a real barrier report at once and delivers one queued drained action
 * and then the matching `barrier_complete` sentinel a moment later, on the
 * `capture:action` stream. Leaving a re-record through a breadcrumb must still
 * discard that action, so it never becomes a pending action of the recording
 * opened next (the desktop side of docent#666).
 */

import { test, expect } from './coverage-fixture.js';
import { installTauriMockServer, openPanel, seedRecordedStep } from './tauri-mock-fixture.js';

// Each stop answers a fresh barrier id, then delivers what a test queued in
// `window.__drainOnNextStop` (if anything) and the sentinel for that id. Page
// globals are reached only inside the function, as the fixture requires.
const server = installTauriMockServer({
  overrides: {
    stop_capture: `() => {
      const id = (window.__stopBarrierId = (window.__stopBarrierId ?? 100) + 1);
      const drained = window.__drainOnNextStop ?? null;
      window.__drainOnNextStop = null;
      setTimeout(() => {
        const handler = window.__TAURI__._listeners['capture:action'];
        if (drained) handler({ payload: drained });
        handler({ payload: { type: 'barrier_complete', barrier_id: id } });
      }, 50);
      return { barrier_id: id, wedged_workers: 0, completion: 'marker_ordered' };
    }`,
  },
});

const click = (text) => ({
  type: 'click',
  capture_mode: 'accessibility',
  context_id: 1,
  element: { text, tag: 'Button', selector: '#btn' },
});

test.describe('Desktop Re-record — leaving drains before it discards', () => {
  for (const [label, crumb, reopenProject] of [
    ['project breadcrumb', '#bc-project', false],
    ['Projects breadcrumb', '#bc-projects', true],
  ]) {
    test(`an action drained by the ${label}'s stop is discarded with the re-record`, async ({
      page,
    }) => {
      await openPanel(page, server);
      await seedRecordedStep(page, {
        project: 'P',
        recording: 'A',
        actions: [click('a')],
        narration: 'a1',
      });
      await page.click('#bc-project');
      await page.waitForSelector('#view-project:not(.hidden)');
      await seedRecordedStep(page, {
        project: null,
        recording: 'B',
        actions: [click('b')],
        narration: 'b0',
      });
      await page.click('#bc-project');
      await page.waitForSelector('#view-project:not(.hidden)');

      const openRecordingNamed = (name) =>
        page
          .locator('#recording-list li', { hasText: name })
          .locator('[data-action="open"]')
          .first()
          .click();

      await openRecordingNamed('A');
      await page.waitForSelector('#view-recording:not(.hidden)');
      await page.locator('[data-action="edit"]').first().click();
      await expect(page.locator('#rerecord-banner')).toBeVisible();

      // The re-record's typing is still held in the backend when the person
      // leaves: the breadcrumb's stop drains it, after its result.
      await page.evaluate(
        (drained) => {
          window.__drainOnNextStop = drained;
        },
        { ...click('held for the re-record'), timestamp: Date.now() },
      );
      await page.click(crumb);
      if (reopenProject) {
        await page.waitForSelector('#view-projects:not(.hidden)');
        await page
          .locator('#project-list li', { hasText: 'P' })
          .locator('[data-action="open"]')
          .first()
          .click();
      }
      await page.waitForSelector('#view-project:not(.hidden)');
      // Past the drain's delivery, whichever order the panel took.
      await page.waitForTimeout(300);

      await openRecordingNamed('B');
      await page.waitForSelector('#view-recording:not(.hidden)');
      await page.fill('#narration-input', 'b1');
      await expect(page.locator('#btn-commit-step')).toBeDisabled();
    });
  }
});
