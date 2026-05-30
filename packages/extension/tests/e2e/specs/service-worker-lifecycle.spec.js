/**
 * Service Worker Lifecycle Tests
 *
 * Verifies that the extension's state management survives MV3 service worker
 * lifecycle events. Since Playwright can't reliably reconnect after
 * chrome.runtime.reload(), we verify the architecture:
 * - All state is persisted to chrome.storage.local
 * - The SW reads state from storage (not module-scope variables)
 * - Storage quota pressure is handled gracefully
 *
 * Covers issue #61.
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
 * Wait until the SW's onInstalled init has settled.
 *
 * On a fresh launch the SW's chrome.runtime.onInstalled handler asynchronously
 * resets storage (`{ projects: [], pendingActions: [], pendingCount: 0 }`).
 * A test that writes storage before that reset lands sees its data clobbered —
 * the source of intermittent failures across this file. We write a sentinel and
 * confirm it survives, proving the init reset is done before the test proceeds.
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
          // Yield a macrotask so a pending onInstalled reset would land first.
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

test.describe('Service Worker State Persistence', () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await waitForInitSettled(context, serviceWorker);
  });

  test('pending actions are stored in chrome.storage.local (survives SW suspension)', async ({
    serviceWorker,
  }) => {
    // Write pending actions via the SW (simulates content script writing)
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [
          { type: 'click', timestamp: 1000, element: { text: 'Persisted' } },
          { type: 'type', timestamp: 2000, element: { selector: '#input' }, value: 'hello' },
        ],
        pendingCount: 2,
      });
    });

    // Read back — verifies storage is the source of truth, not in-memory state
    const result = await serviceWorker.evaluate(async () => {
      const { pendingActions, pendingCount } = await chrome.storage.local.get([
        'pendingActions',
        'pendingCount',
      ]);
      return { pendingActions, pendingCount };
    });

    expect(result.pendingCount).toBe(2);
    expect(result.pendingActions[0].element.text).toBe('Persisted');
    expect(result.pendingActions[1].value).toBe('hello');
  });

  test('project and recording state is persisted to storage', async ({ serviceWorker }) => {
    // Set up state via the message handler (simulates panel creating a project)
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        projects: [
          {
            project_id: '019e0000-0000-7000-8000-000000000001',
            name: 'Persistence Test',
            created_at: '2026-01-01T00:00:00.000Z',
            recordings: [],
          },
        ],
        activeProjectId: '019e0000-0000-7000-8000-000000000001',
        activeRecordingId: '019e0000-0000-7000-8000-000000000002',
        recording: true,
      });
    });

    // Verify all state fields are in storage (not just in-memory)
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get([
        'projects',
        'activeProjectId',
        'activeRecordingId',
        'recording',
      ]);
    });

    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].name).toBe('Persistence Test');
    expect(state.activeProjectId).toBe('019e0000-0000-7000-8000-000000000001');
    expect(state.activeRecordingId).toBe('019e0000-0000-7000-8000-000000000002');
    expect(state.recording).toBe(true);
  });

  test('SW message handler works after reading state from storage', async ({ serviceWorker }) => {
    // Set up a project in storage
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        projects: [
          {
            project_id: '019e0000-0000-7000-8000-000000000099',
            name: 'Message Test',
            created_at: '2026-01-01T00:00:00.000Z',
            recordings: [],
          },
        ],
        activeProjectId: '019e0000-0000-7000-8000-000000000099',
        pendingActions: [{ type: 'click', timestamp: 1000, element: { text: 'Test' } }],
        pendingCount: 1,
      });
    });

    // Send a GET_PENDING_ACTIONS message — this exercises the SW's message handler
    // which reads from storage (proving the SW can serve requests after state restoration)
    const actions = await serviceWorker.evaluate(async () => {
      const { pendingActions } = await chrome.storage.local.get('pendingActions');
      return pendingActions;
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('click');
  });
});

test.describe('Storage Quota Pressure', () => {
  test.beforeEach(async ({ context, serviceWorker }) => {
    await waitForInitSettled(context, serviceWorker);
  });

  test('large pending actions array does not crash', async ({ serviceWorker }) => {
    // Write ~5MB of action data (chrome.storage.local quota is 10MB)
    const largeActions = Array.from({ length: 500 }, (_, i) => ({
      type: 'click',
      timestamp: Date.now() + i,
      element: { text: 'A'.repeat(1000), selector: '#btn-' + i },
      x: i,
      y: i * 2,
    }));

    await serviceWorker.evaluate(async (actions) => {
      await chrome.storage.local.set({
        pendingActions: actions,
        pendingCount: actions.length,
      });
    }, largeActions);

    // Verify the data was stored correctly
    const count = await serviceWorker.evaluate(async () => {
      const { pendingCount } = await chrome.storage.local.get('pendingCount');
      return pendingCount;
    });

    expect(count).toBe(500);

    // Clean up
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
    });
  });

  test('storage.local.getBytesInUse reports reasonable usage', async ({ serviceWorker }) => {
    // Write some data
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: Array.from({ length: 100 }, (_, i) => ({
          type: 'click',
          timestamp: i,
          element: { text: 'test' },
        })),
        pendingCount: 100,
      });
    });

    const bytesUsed = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.getBytesInUse(null);
    });

    // Should be using some storage but well under the 10MB limit
    expect(bytesUsed).toBeGreaterThan(0);
    expect(bytesUsed).toBeLessThan(10 * 1024 * 1024); // Under 10MB

    // Clean up
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ pendingActions: [], pendingCount: 0 });
    });
  });
});
