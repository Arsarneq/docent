/**
 * E2E Test — Storage-quota paused gate, driven by a LIVE capture (#127 follow-up).
 *
 * The "Storage-quota warning + pause (#127)" suite in storage-quota.spec.js
 * verifies the pause *state machine* and the panel UI (banner, override button,
 * detection via RECORDING_CLEAR). What it does NOT do is push a real captured
 * action through the gate — `appendToPending()`'s `if (storagePaused) return false`.
 *
 * This test fills that gap end-to-end: a real DOM click is recorded by the live
 * content-script recorder, forwarded to the service worker, and must be
 * **dropped** while capture is paused and **captured** again after the user
 * overrides. Quota pressure is injected deterministically by stubbing
 * `chrome.storage.local.getBytesInUse` in the SW (no real 9 MB fill).
 */

import {
  test,
  expect,
  getPendingActions,
  waitForActionsToSettle,
  setTestContent,
} from '../helpers/extension-fixture.js';

// The recorder runs in the page; the panel is an extension context whose
// runtime messages the SW's onMessage actually receives (a SW can't message
// itself). We use it only to drive RECORDING_CLEAR / STORAGE_RESUME.
async function openPanel(context, serviceWorker) {
  const extensionId = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)[1];
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  return panel;
}

test.describe('Storage-quota paused gate — live capture (#127)', () => {
  test('a live captured action is dropped while paused, then captured after the user overrides', async ({
    context,
    testPage,
    serviceWorker,
  }) => {
    const panel = await openPanel(context, serviceWorker);
    const sendToSW = (type) => panel.evaluate((t) => chrome.runtime.sendMessage({ type: t }), type);
    const quota = () =>
      serviceWorker.evaluate(
        async () => (await chrome.storage.local.get('docentStorageQuota')).docentStorageQuota,
      );
    const clickCount = async () =>
      (await getPendingActions(serviceWorker)).filter((a) => a.type === 'click').length;

    await setTestContent(
      testPage,
      /* html */ `<!DOCTYPE html><html><body><button id="btn">Click me</button></body></html>`,
    );

    // Start from a known-unpaused state regardless of prior tests: report low
    // usage and re-evaluate (RECORDING_CLEAR), clearing the in-memory pause flag
    // and the pending list.
    await serviceWorker.evaluate(() => {
      globalThis.__realGetBytesInUse = chrome.storage.local.getBytesInUse.bind(
        chrome.storage.local,
      );
      chrome.storage.local.getBytesInUse = () => Promise.resolve(1024);
    });
    await sendToSW('RECORDING_CLEAR');
    await expect.poll(async () => (await quota())?.paused ?? false).toBe(false);

    // Now report 90% usage (> 80% warn threshold) deterministically.
    await serviceWorker.evaluate(() => {
      chrome.storage.local.getBytesInUse = () =>
        Promise.resolve(Math.floor(10 * 1024 * 1024 * 0.9));
    });

    // 1) First real click is captured; crossing the warn threshold auto-pauses
    //    capture (appendToPending re-evaluates pressure right after appending).
    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);
    expect(await clickCount()).toBe(1);
    await expect.poll(async () => (await quota())?.paused).toBe(true);

    // 2) A real click WHILE PAUSED reaches the SW but is dropped at the gate —
    //    the captured-action count must not grow.
    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);
    expect(await clickCount()).toBe(1);

    // 3) The user overrides ("keep recording") via STORAGE_RESUME.
    await sendToSW('STORAGE_RESUME');
    await expect.poll(async () => (await quota())?.paused).toBe(false);
    expect((await quota()).override).toBe(true);

    // 4) A real click after the override is captured again.
    await testPage.click('#btn');
    await waitForActionsToSettle(serviceWorker, testPage);
    expect(await clickCount()).toBe(2);

    // Restore the real quota probe.
    await serviceWorker.evaluate(() => {
      chrome.storage.local.getBytesInUse = globalThis.__realGetBytesInUse;
    });
    await panel.close();
  });
});
