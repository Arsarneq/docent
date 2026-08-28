/**
 * sync-samples.spec.js — End-to-end client-pull guard against stale seed samples
 * (extension side).
 *
 * This is one half of the "complete guarding" around the Reference Sync Server's
 * bundled seed samples. The sibling shared unit guard
 * (reference-implementations/sync-server/tests/unit/samples-conformance.test.js)
 * proves each sample validates against its platform schema. THIS test proves the
 * stronger, real-world property: the actual Chrome extension — real service
 * worker, real `sync-client`, real generated validator, real reconcile — can
 * PULL the seeded sample from a real running Reference Sync Server and reconcile
 * it into a project, rather than rejecting it.
 *
 * Why this catches sample drift before release: the extension's pull path runs
 * `checkStampCompatibility` + `validatePayload` on every pulled payload. If a
 * schema-shape change lands without updating the bundled `extension-sample.json`,
 * the now-stale sample fails that validation on pull → it lands in the cycle's
 * `errors`/`mismatched` instead of reconciling into a project → this test fails,
 * on the feature PR that made the change. (The version-stamp half stays in
 * lockstep automatically: `update-version-table.js` re-stamps the samples at
 * release, so a feature-branch run never sees a version mismatch.)
 *
 * Cross-platform routing is asserted too: `{ samples: true }` seeds BOTH an
 * `extension`-stamped and a `desktop-windows`-stamped project. The extension
 * client must ACCEPT its own platform's sample (it appears as a project) and
 * REJECT the other platform's sample as a stamp mismatch (it does not appear as
 * a project, and is reported, not errored). That exercises the real
 * stamp-compatibility gate end-to-end.
 *
 * ── Network shape (no CORS workaround needed here) ───────────────────────────
 * The extension fetches from the service worker / panel with `<all_urls>` host
 * permission, so a direct `fetch` to the loopback reference server is NOT
 * subject to page CORS — a genuine direct pull works against the no-CORS
 * reference server. (The desktop integration test cannot do this — it runs in a
 * plain Chromium page, not the Tauri webview — so it uses a same-origin proxy;
 * see packages/desktop/tests/integration/sync-samples.spec.js.)
 *
 * Server lifecycle: the real Reference Sync Server is spawned as a child process
 * on an ephemeral port over a per-run temp storage directory (through the
 * suite's launcher, which hands the directory to the server's own documented
 * storage-provider override), its bound URL parsed from stdout, seeded via
 * its own `POST /__debug/seed { samples: true }` (exercising the real seed
 * affordance + the real sample files), and torn down after the suite together
 * with the run's storage directory — so simultaneous runs on one machine never
 * share server state.
 */

import { test as base, expect, chromium } from '@playwright/test';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');
// The suite's spawnable entry for reference-implementations/sync-server: it
// runs the real server over the storage directory passed to it (see the
// launcher's header for the seam it exposes).
const SERVER_LAUNCHER = path.resolve(__dirname, '../helpers/reference-server-launcher.js');

/**
 * Spawn the real Reference Sync Server on an ephemeral port, storing under a
 * fresh per-run temp directory (passed through the launcher to the server's
 * own documented storage-provider override); resolve with its base URL once it
 * logs the bound address. The returned async `stop` kills the child and
 * removes the run's storage directory.
 *
 * @returns {Promise<{ baseUrl: string, stop: () => Promise<void> }>}
 */
async function startReferenceServer() {
  // Fresh storage per run: simultaneous runs never share server state, and the
  // machine-wide default storage directory is never touched.
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'docent-sync-samples-e2e-'));
  // `maxRetries` absorbs the transient EBUSY/EPERM a just-killed child's open
  // handles can cause on Windows.
  const removeStorageDir = () =>
    rm(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  let child;
  try {
    return await new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [SERVER_LAUNCHER, '--storage-dir', storageDir, '--port', '0'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      const onData = (chunk) => {
        out += chunk.toString();
        // startServer logs: "Reference Sync Server listening on http://localhost:<port>"
        const match = out.match(/listening on (http:\/\/\S+)/);
        if (match) {
          child.stdout.off('data', onData);
          resolve({
            baseUrl: match[1].trim(),
            stop: async () => {
              await new Promise((exited) => {
                if (child.exitCode !== null || child.signalCode !== null) {
                  exited();
                  return;
                }
                child.once('exit', exited);
                child.kill();
              });
              await removeStorageDir();
            },
          });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (c) => {
        out += c.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== null && code !== 0 && !out.includes('listening on')) {
          reject(new Error(`Reference server exited early (code ${code}):\n${out}`));
        }
      });
      setTimeout(() => reject(new Error(`Reference server did not start in time:\n${out}`)), 10000);
    });
  } catch (err) {
    // Kill the child BEFORE removing the directory — a server still starting
    // constructs its storage provider late enough to recreate a directory
    // removed under it. The wait is capped: this is already the failure path.
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((exited) => {
        const cap = setTimeout(exited, 5000);
        child.once('exit', () => {
          clearTimeout(cap);
          exited();
        });
        child.kill();
      });
    }
    await removeStorageDir().catch(() => {});
    throw err;
  }
}

const test = base.extend({
  // Persistent context with the extension loaded (extensions need headed mode).
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = sw.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
    await use(id);
  },

  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await use(page);
    await page.close();
  },
});

test.describe('Sync pulls the bundled seed samples end-to-end (extension)', () => {
  let server;

  test.beforeAll(async () => {
    server = await startReferenceServer();
    // The spawned server stores under a fresh per-run temp directory, so the
    // store starts empty and the pull sees EXACTLY the two bundled samples —
    // no reset needed, and nothing shared with any other run on the machine.
    // Seed both bundled samples (extension + desktop-windows) via the real seed
    // affordance — this also exercises the server's `{ samples: true }` path and
    // the on-disk sample files.
    const res = await fetch(`${server.baseUrl}/__debug/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ samples: true }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, seeded: 2 });
  });

  test.afterAll(async () => {
    await server?.stop();
  });

  test('pulls and reconciles the extension sample; rejects the desktop sample as a stamp mismatch', async ({
    panelPage,
  }) => {
    // Configure the sync endpoint to the running reference server (loopback
    // http:// with no API key is permitted by validateEndpointUrl).
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#settings-sync-url', server.baseUrl);
    await panelPage.click('#btn-settings-sync-save');
    await panelPage.waitForTimeout(300);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // The sync summary surfaces via an alert dialog — capture its text so we can
    // assert the pulled/mismatched outcome, then accept it.
    let summaryText = '';
    panelPage.on('dialog', (dialog) => {
      summaryText = dialog.message();
      dialog.accept();
    });

    await expect(panelPage.locator('#btn-sync')).toBeEnabled();
    await panelPage.click('#btn-sync');

    // Wait for the cycle to finish (button returns from "Syncing…" to "Sync").
    await expect(panelPage.locator('#btn-sync')).toHaveText('Sync', { timeout: 15000 });

    // ── The extension sample reconciled into a real project ──────────────────
    // The bundled extension sample's project name (see
    // reference-implementations/sync-server/samples/extension-sample.json).
    const EXT_PROJECT = 'Extension sample — Expense report submission';
    const DESK_PROJECT = 'Desktop (Windows) sample — Invoice export flow';

    await expect(panelPage.locator('.card-item-name', { hasText: EXT_PROJECT })).toBeVisible({
      timeout: 10000,
    });

    // ── The desktop sample was NOT reconciled (wrong platform stamp) ─────────
    await expect(panelPage.locator('.card-item-name', { hasText: DESK_PROJECT })).toHaveCount(0);

    // ── The summary reports the desktop sample as a compatibility skip, not a
    // hard error or a successful pull. The pull-side stamp check routes a
    // wrong-platform payload to `mismatched` (surfaced as "Skipped"), never to
    // `errors`. ──
    expect(summaryText).toMatch(/Pulled\s+1\s+project/i);
    expect(summaryText).toMatch(/[Ss]kipped/);
    expect(summaryText).not.toMatch(/failed schema validation/i);
  });
});
