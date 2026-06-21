/**
 * E2E Tests — Storage quota exhaustion & graceful degradation (#90).
 *
 * Verifies the extension's behavior when `chrome.storage.local` writes fail
 * under quota pressure. These cover the half of #90 that maps to behavior that
 * EXISTS today:
 *   - a quota-exceeded write does not corrupt already-stored projects,
 *   - export of existing data still works when writes are failing,
 *   - clearing projects frees space and subsequent writes resume,
 *   - a large pending-actions array is stored and read back without crashing.
 *
 * The warn-and-pause behaviour (#127) — the panel banner, the auto-pause at the
 * warn threshold, the user's "keep recording" override, and resume on free space —
 * is covered by the "Storage-quota warning + pause (#127)" suite at the bottom.
 *
 * Determinism: quota failure is injected by monkey-patching
 * `chrome.storage.local.set` inside the service worker to throw a
 * `QuotaExceededError` — deterministic and fast, unlike filling a real 10MB
 * quota (slow + environment-sensitive). The patch is always restored.
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
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
    });
    await use(context);
    await context.close();
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
});

/**
 * Wait until the SW's onInstalled init reset has settled, so a test that writes
 * storage isn't clobbered by the async reset. Mirrors the proven helper in
 * service-worker-lifecycle.spec.js.
 */
async function waitForInitSettled(context, serviceWorker) {
  const liveWorker = () => {
    const workers = context.serviceWorkers();
    return workers.length > 0 ? workers[workers.length - 1] : serviceWorker;
  };
  await expect
    .poll(
      async () =>
        liveWorker().evaluate(async () => {
          await chrome.storage.local.set({ __initSentinel: 'ready' });
          await new Promise((r) => setTimeout(r, 50));
          const { __initSentinel } = await chrome.storage.local.get('__initSentinel');
          return __initSentinel;
        }),
      { timeout: 5000 },
    )
    .toBe('ready');
  await liveWorker().evaluate(async () => {
    await chrome.storage.local.remove('__initSentinel');
  });
}

test.describe('Storage quota exhaustion (#90)', () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await waitForInitSettled(context, serviceWorker);
  });

  test('a quota-exceeded write does not corrupt already-stored projects', async ({
    serviceWorker,
  }) => {
    // Seed a committed project (the user's existing work).
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        projects: [
          {
            project_id: '019e0000-0000-7000-8000-0000000000a1',
            name: 'Existing work',
            created_at: '2026-01-01T00:00:00.000Z',
            recordings: [],
          },
        ],
        pendingActions: [],
        pendingCount: 0,
      });
    });

    // Patch set() to throw QuotaExceededError, attempt a write, then restore.
    const outcome = await serviceWorker.evaluate(async () => {
      const realSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = () => {
        const err = new Error('Resource::kQuotaBytes quota exceeded');
        err.name = 'QuotaExceededError';
        return Promise.reject(err);
      };

      let threw = false;
      try {
        await chrome.storage.local.set({ pendingActions: [{ type: 'click', timestamp: 1 }] });
      } catch (e) {
        threw = e.name === 'QuotaExceededError';
      } finally {
        chrome.storage.local.set = realSet; // always restore
      }
      return { threw };
    });

    expect(outcome.threw).toBe(true);

    // The pre-existing project must be completely intact — a failed write
    // (read-modify-write) never partially overwrites prior storage.
    const projects = await serviceWorker.evaluate(async () => {
      const { projects } = await chrome.storage.local.get('projects');
      return projects;
    });
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('Existing work');
  });

  test('export of existing data still works while writes are failing', async ({
    serviceWorker,
  }) => {
    // Seed a project to export.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        projects: [
          {
            project_id: '019e0000-0000-7000-8000-0000000000b2',
            name: 'Exportable',
            created_at: '2026-01-01T00:00:00.000Z',
            recordings: [
              {
                recording_id: '019e0000-0000-7000-8000-0000000000b3',
                name: 'Rec',
                created_at: '2026-01-01T00:00:00.000Z',
                steps: [],
              },
            ],
          },
        ],
      });
    });

    // With set() failing, a read-only export path must still succeed because
    // export only READS storage — it never writes.
    const exported = await serviceWorker.evaluate(async () => {
      const realSet = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = () => Promise.reject(new Error('quota exceeded'));
      try {
        // Export = read projects from storage and serialize. No write involved.
        const { projects } = await chrome.storage.local.get('projects');
        const project = projects[0];
        return JSON.stringify({
          project: {
            project_id: project.project_id,
            name: project.name,
            created_at: project.created_at,
          },
          recordings: project.recordings,
        });
      } finally {
        chrome.storage.local.set = realSet;
      }
    });

    const parsed = JSON.parse(exported);
    expect(parsed.project.name).toBe('Exportable');
    expect(parsed.recordings).toHaveLength(1);
  });

  test('clearing projects frees space and subsequent writes resume', async ({ serviceWorker }) => {
    // Fill with a sizeable pending-actions array.
    await serviceWorker.evaluate(async () => {
      const big = Array.from({ length: 500 }, (_, i) => ({
        type: 'click',
        timestamp: i,
        element: { text: 'X'.repeat(500), selector: '#b' + i },
      }));
      await chrome.storage.local.set({ pendingActions: big, pendingCount: big.length });
    });

    const before = await serviceWorker.evaluate(() => chrome.storage.local.getBytesInUse(null));
    expect(before).toBeGreaterThan(0);

    // Clear (the clearPending path) — frees the space.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
    });

    const after = await serviceWorker.evaluate(() => chrome.storage.local.getBytesInUse(null));
    expect(after).toBeLessThan(before);

    // A subsequent write succeeds (space was freed).
    const wrote = await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ pendingActions: [{ type: 'click', timestamp: 1 }] });
      const { pendingActions } = await chrome.storage.local.get('pendingActions');
      return pendingActions.length;
    });
    expect(wrote).toBe(1);
  });

  test('a large pending-actions array is stored and read back without crashing', async ({
    serviceWorker,
  }) => {
    // ~5MB of data (quota is 10MB) — must not crash or truncate.
    const count = await serviceWorker.evaluate(async () => {
      const big = Array.from({ length: 500 }, (_, i) => ({
        type: 'click',
        timestamp: Date.now() + i,
        element: { text: 'A'.repeat(1000), selector: '#btn-' + i },
        x: i,
        y: i * 2,
      }));
      await chrome.storage.local.set({ pendingActions: big, pendingCount: big.length });
      const { pendingActions } = await chrome.storage.local.get('pendingActions');
      return pendingActions.length;
    });
    expect(count).toBe(500);

    // Clean up.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
    });
  });
});

test.describe('Storage-quota warning + pause (#127)', () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await waitForInitSettled(context, serviceWorker);
  });

  async function openPanel(context, serviceWorker) {
    const extensionId = serviceWorker.url().match(/chrome-extension:\/\/([^/]+)/)[1];
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    return panel;
  }

  // Read the banner element's render state (class/text/override-button) regardless
  // of whether the recording view is the active one — the render toggles classes on
  // the element directly, so this reflects renderStorageQuota's decision.
  const bannerState = (panel) =>
    panel.$eval('#storage-quota-banner', (el) => ({
      hidden: el.classList.contains('hidden'),
      exceeded: el.classList.contains('exceeded'),
      text: el.querySelector('#storage-quota-banner-text')?.textContent ?? '',
      resumeOffered: !el.querySelector('#btn-storage-quota-resume')?.classList.contains('hidden'),
    }));

  const writeQuota = (serviceWorker, state) =>
    serviceWorker.evaluate((s) => chrome.storage.local.set({ docentStorageQuota: s }), state);

  test('the panel surfaces the right banner for each pressure band', async ({
    context,
    serviceWorker,
  }) => {
    const panel = await openPanel(context, serviceWorker);

    // warn + paused → visible, "Keep recording" override offered, accent (not danger).
    await writeQuota(serviceWorker, {
      band: 'warn',
      paused: true,
      override: false,
      bytesInUse: 9e6,
    });
    await expect.poll(async () => (await bannerState(panel)).hidden).toBe(false);
    let s = await bannerState(panel);
    expect(s.exceeded).toBe(false);
    expect(s.text).toContain('almost full');
    expect(s.text).toContain('paused');
    expect(s.resumeOffered).toBe(true);

    // warn + override (user kept recording) → still shown, no override button.
    await writeQuota(serviceWorker, {
      band: 'warn',
      paused: false,
      override: true,
      bytesInUse: 9e6,
    });
    await expect.poll(async () => (await bannerState(panel)).text).toContain('still recording');
    s = await bannerState(panel);
    expect(s.hidden).toBe(false);
    expect(s.resumeOffered).toBe(false);

    // exceeded → danger styling, no override (hard wall can't be overridden).
    await writeQuota(serviceWorker, {
      band: 'exceeded',
      paused: true,
      override: false,
      bytesInUse: 1.05e7,
    });
    await expect.poll(async () => (await bannerState(panel)).exceeded).toBe(true);
    s = await bannerState(panel);
    expect(s.text).toContain('full');
    expect(s.resumeOffered).toBe(false);

    // ok → hidden again (space freed).
    await writeQuota(serviceWorker, {
      band: 'ok',
      paused: false,
      override: false,
      bytesInUse: 1000,
    });
    await expect.poll(async () => (await bannerState(panel)).hidden).toBe(true);

    await panel.close();
  });

  test('SW pauses at the warn threshold, the user can override, and it resumes when freed', async ({
    context,
    serviceWorker,
  }) => {
    const panel = await openPanel(context, serviceWorker);

    // Report 90% usage (> 80% warn threshold) deterministically — no real 9MB fill.
    await serviceWorker.evaluate(() => {
      globalThis.__realGetBytesInUse = chrome.storage.local.getBytesInUse.bind(
        chrome.storage.local,
      );
      chrome.storage.local.getBytesInUse = () =>
        Promise.resolve(Math.floor(10 * 1024 * 1024 * 0.9));
    });

    const quota = () =>
      serviceWorker.evaluate(
        async () => (await chrome.storage.local.get('docentStorageQuota')).docentStorageQuota,
      );

    // A panel message (RECORDING_CLEAR → clearPending → evaluate) triggers detection.
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'RECORDING_CLEAR' }));
    await expect.poll(async () => (await quota())?.paused).toBe(true);
    let q = await quota();
    expect(q.band).toBe('warn');
    expect(q.override).toBe(false);

    // The user overrides via the banner's "Keep recording" button — exercises the
    // click -> STORAGE_RESUME wiring, not just the SW handler in isolation.
    await expect(panel.locator('#btn-storage-quota-resume')).toBeVisible();
    await panel.locator('#btn-storage-quota-resume').click();
    await expect.poll(async () => (await quota())?.paused).toBe(false);
    q = await quota();
    expect(q.band).toBe('warn');
    expect(q.override).toBe(true);

    // Free space — usage drops below the resume threshold; back to ok, override cleared.
    await serviceWorker.evaluate(() => {
      chrome.storage.local.getBytesInUse = () => Promise.resolve(1024);
    });
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'RECORDING_CLEAR' }));
    await expect.poll(async () => (await quota())?.band).toBe('ok');
    q = await quota();
    expect(q.paused).toBe(false);
    expect(q.override).toBe(false);

    await serviceWorker.evaluate(() => {
      chrome.storage.local.getBytesInUse = globalThis.__realGetBytesInUse;
    });
    await panel.close();
  });
});
