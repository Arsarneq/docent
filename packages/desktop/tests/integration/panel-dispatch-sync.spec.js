/**
 * Desktop Panel — Dispatch & Sync Flow Tests
 *
 * Tests the dispatch and sync surfaces: the settings each saves, rejects, and
 * reads back (sync across a fresh-document re-open too), the connection-test
 * status and the Auto-Sync enable, the sync button gate, and the dispatch
 * button gate with its confirmation flow.
 */

import { test, expect } from './coverage-fixture.js';
import {
  createProject,
  installTauriMockServer,
  invokesOf,
  openPanel,
  seedRecordedStep,
  SUBMIT_CLICK,
} from './tauri-mock-fixture.js';

const server = installTauriMockServer();

test.describe('Desktop Panel — Dispatch Settings', () => {
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
  // Read in one page turn on purpose: the save_state count and the saved blob
  // must come from the same instant, and a function serialised into the page
  // cannot call the fixture's readers — this is the one spec-side read of the
  // mock's invoke record, and the integration-suite locks name it.
  const probeBlob = () => {
    const writes = window.__TAURI__
      ._getInvokeCalls()
      .filter((call) => call.cmd === 'save_state').length;
    let settings;
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
    `[panel-dispatch-sync] the persisted blob never settled to ${JSON.stringify(expected)} within ` +
      `${timeout}ms; it holds ${JSON.stringify(held)}. The last write wins, and the last write is the panel's own whole-blob save — so a seam save the panel does not mirror back leaves the blob at the value here.`,
    cause ? { cause } : undefined,
  );
}

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

  // Opening the panel again as a fresh document starts it over from the
  // persisted blob, so what these two read is the file. Re-opening Settings
  // inside one document proves nothing here — the fields repopulate from the
  // in-memory copy the panel is already holding; 'saving sync settings persists
  // sync URL' above reads the value back inside one document. That is what
  // makes these two the assertion the panel's mirror-back beside the seam save
  // answers to: the seam's own write is followed by the panel's whole-blob
  // save, and only the mirrored values reach the blob that survives a re-open
  // (the rule is the desktop caller model in the PlatformAdapter typedef's
  // header, packages/shared/views/adapter.js).
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
    const keepAliveCalls = await invokesOf(page, 'set_auto_sync_keepalive');
    expect(keepAliveCalls.length).toBeGreaterThan(0);
    expect(keepAliveCalls.at(-1).args.enabled).toBe(true);
  });
});

test.describe('Desktop Panel — Sync Button', () => {
  test('sync button is visible and disabled without config', async ({ page }) => {
    await openPanel(page, server);
    await expect(page.locator('#btn-sync')).toBeVisible();
    await expect(page.locator('#btn-sync')).toBeDisabled();
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
});

test.describe('Desktop Panel — Dispatch Flow', () => {
  test('dispatch button disabled without endpoint configured', async ({ page }) => {
    await openPanel(page, server);
    await seedRecordedStep(page, {
      project: 'Dispatch Test',
      recording: 'Flow',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });

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
    await seedRecordedStep(page, {
      project: 'D',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });

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
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-confirm-cancel');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  });

  test('dispatch button disabled on a new project with no steps and no endpoint', async ({
    page,
  }) => {
    await openPanel(page, server);

    await createProject(page, 'Dispatch Test');

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
    await seedRecordedStep(page, {
      project: 'P',
      recording: 'R',
      actions: [SUBMIT_CLICK],
      narration: 'Click submit',
    });

    // Go back to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#btn-dispatch-project')).toBeEnabled();
  });
});
