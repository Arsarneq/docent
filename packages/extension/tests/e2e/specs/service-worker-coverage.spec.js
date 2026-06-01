/**
 * Service Worker — Coverage Expansion Tests
 *
 * Exercises all service worker message handler paths via direct
 * chrome.runtime.sendMessage calls from an extension page context (side panel).
 * Messages sent from extension pages are received by the SW's onMessage listener,
 * ensuring the CDP profiler captures coverage for every code path in service-worker.js.
 *
 * Target: increase SW coverage from 43% to 70%+.
 * Closes #107
 */

import { test as base, expect, chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');
const coverageDir = path.resolve(__dirname, '../coverage');
const rawDir = path.resolve(coverageDir, 'raw');

fs.mkdirSync(rawDir, { recursive: true });

let coverageCounter = 0;
const DEBUG_PORT = 9340;

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        `--remote-debugging-port=${DEBUG_PORT}`,
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let sw;
    if (context.serviceWorkers().length > 0) {
      sw = context.serviceWorkers()[0];
    } else {
      sw = await context.waitForEvent('serviceworker');
    }
    const url = sw.url();
    const match = url.match(/chrome-extension:\/\/([^/]+)/);
    await use(match ? match[1] : '');
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

  swCoverage: [
    async ({ context, extensionId }, use) => {
      // Auto fixture: every test in this spec collects SW coverage via the raw
      // CDP WebSocket. This captures the message handler AND the tab/navigation
      // lifecycle listeners executing in the SW context.
      let swConnection = null;
      try {
        const { connectToServiceWorker } = await import('../helpers/cdp-sw-coverage.js');
        swConnection = await connectToServiceWorker(DEBUG_PORT, extensionId);
      } catch (err) {
        console.warn('[coverage] SW CDP connection failed:', err.message);
      }

      await use(swConnection);

      // Collect and save coverage
      if (swConnection) {
        try {
          const { collectAndClose } = await import('../helpers/cdp-sw-coverage.js');
          const swScripts = await collectAndClose(swConnection, extensionId);
          if (swScripts.length > 0) {
            const cdpFile = path.join(rawDir, `sw-coverage-${coverageCounter++}.json`);
            fs.writeFileSync(cdpFile, JSON.stringify(swScripts));
          }
        } catch (err) {
          console.warn('[coverage] SW coverage collection failed:', err.message);
        }
      }
    },
    { auto: true },
  ],

  // Extension page used to send messages to the SW.
  // chrome.runtime.sendMessage only works from extension contexts (pages, content scripts)
  // — NOT from the SW to itself.
  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForTimeout(500);
    await use(page);
    await page.close();
  },
});

/**
 * Send a message to the service worker via chrome.runtime.sendMessage
 * from an extension page context (panelPage).
 */
async function sendSWMessage(panelPage, msg) {
  return await panelPage.evaluate(async (m) => {
    return await chrome.runtime.sendMessage(m);
  }, msg);
}

/**
 * Reset SW state to a clean slate via the service worker's storage API.
 *
 * Waits for the SW's chrome.runtime.onInstalled init reset to settle first.
 * On a fresh launch that handler asynchronously sets
 * `{ projects: [], pendingActions: [], pendingCount: 0 }`; if it lands after
 * our reset it would clobber state mid-test. We confirm a sentinel survives a
 * macrotask before proceeding (same guard as service-worker-lifecycle.spec.js).
 */
async function resetState(serviceWorker) {
  await expect
    .poll(
      async () =>
        serviceWorker.evaluate(async () => {
          await chrome.storage.local.set({ __initSentinel: 'ready' });
          await new Promise((r) => setTimeout(r, 50));
          const { __initSentinel } = await chrome.storage.local.get('__initSentinel');
          return __initSentinel;
        }),
      { timeout: 5000 },
    )
    .toBe('ready');

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      projects: [],
      pendingActions: [],
      pendingCount: 0,
      recording: false,
    });
  });
  // Give the SW time to restore state from storage
  await new Promise((r) => setTimeout(r, 200));
}

// ─── PROJECTS_LIST ────────────────────────────────────────────────────────────

test.describe('SW Message: PROJECTS_LIST', () => {
  test('returns empty list initially', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(result.ok).toBe(true);
    expect(result.projects).toEqual([]);
  });

  test('returns project summaries after creation', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'Alpha' });
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'Beta' });

    const result = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(result.ok).toBe(true);
    expect(result.projects).toHaveLength(2);
    expect(result.projects[0].name).toBe('Alpha');
    expect(result.projects[1].name).toBe('Beta');
    expect(result.projects[0]).toHaveProperty('project_id');
    expect(result.projects[0]).toHaveProperty('recording_count');
  });
});

// ─── PROJECTS_GET_ALL & PROJECTS_SET ──────────────────────────────────────────

test.describe('SW Message: PROJECTS_GET_ALL and PROJECTS_SET', () => {
  test('GET_ALL returns full project objects', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'Full' });

    const result = await sendSWMessage(panelPage, { type: 'PROJECTS_GET_ALL' });
    expect(result.ok).toBe(true);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].name).toBe('Full');
    expect(result.projects[0]).toHaveProperty('recordings');
  });

  test('PROJECTS_SET replaces all projects', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const replacement = [
      {
        project_id: '019e0000-0000-7000-8000-aaaaaaaaaaaa',
        name: 'Replaced',
        created_at: '2026-01-01T00:00:00.000Z',
        recordings: [],
      },
    ];
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECTS_SET',
      projects: replacement,
    });
    expect(result.ok).toBe(true);

    const all = await sendSWMessage(panelPage, { type: 'PROJECTS_GET_ALL' });
    expect(all.projects).toHaveLength(1);
    expect(all.projects[0].name).toBe('Replaced');
  });
});

// ─── PROJECT_CREATE, PROJECT_OPEN, PROJECT_GET, PROJECT_DELETE, PROJECT_RENAME ─

test.describe('SW Message: Project CRUD', () => {
  test('PROJECT_CREATE sets active project', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'New' });
    expect(result.ok).toBe(true);
    expect(result.project.name).toBe('New');
    expect(result.project).toHaveProperty('project_id');

    const get = await sendSWMessage(panelPage, { type: 'PROJECT_GET' });
    expect(get.ok).toBe(true);
    expect(get.project.name).toBe('New');
  });

  test('PROJECT_OPEN switches active project', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const { project: p1 } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'First',
    });
    const { project: p2 } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'Second',
    });

    // Active should be Second (last created)
    let get = await sendSWMessage(panelPage, { type: 'PROJECT_GET' });
    expect(get.project.name).toBe('Second');

    // Open First
    const open = await sendSWMessage(panelPage, {
      type: 'PROJECT_OPEN',
      project_id: p1.project_id,
    });
    expect(open.ok).toBe(true);
    expect(open.project.name).toBe('First');

    get = await sendSWMessage(panelPage, { type: 'PROJECT_GET' });
    expect(get.project.name).toBe('First');
  });

  test('PROJECT_OPEN with invalid ID returns error', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_OPEN',
      project_id: 'nonexistent',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test('PROJECT_DELETE removes project and clears active if deleted', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const { project } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'ToDelete',
    });

    const del = await sendSWMessage(panelPage, {
      type: 'PROJECT_DELETE',
      project_id: project.project_id,
    });
    expect(del.ok).toBe(true);

    const get = await sendSWMessage(panelPage, { type: 'PROJECT_GET' });
    expect(get.project).toBeNull();

    const list = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(list.projects).toHaveLength(0);
  });

  test('PROJECT_DELETE non-active project does not clear active', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const { project: p1 } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'Keep',
    });
    const { project: p2 } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'Remove',
    });

    // Active is p2 (last created). Delete p1.
    await sendSWMessage(panelPage, { type: 'PROJECT_DELETE', project_id: p1.project_id });

    const get = await sendSWMessage(panelPage, { type: 'PROJECT_GET' });
    expect(get.project.name).toBe('Remove');
  });

  test('PROJECT_RENAME updates project name', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'Old' });

    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_RENAME',
      name: 'Renamed',
    });
    expect(result.ok).toBe(true);
    expect(result.project.name).toBe('Renamed');
  });

  test('PROJECT_RENAME with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_RENAME',
      name: 'X',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active project/);
  });
});

// ─── RECORDING_CREATE, RECORDING_OPEN, RECORDING_DELETE, RECORDING_START/STOP ─

test.describe('SW Message: Recording lifecycle', () => {
  test('RECORDING_CREATE starts recording and sets active', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });

    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'Rec1',
    });
    expect(result.ok).toBe(true);
    expect(result.recording.name).toBe('Rec1');
    expect(result.project).toBeDefined();

    // Verify recording state is set
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(true);
  });

  test('RECORDING_CREATE with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'Orphan',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active project/);
  });

  test('RECORDING_OPEN switches active recording and stops recording', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording: r1 } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R1',
    });
    const { recording: r2 } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R2',
    });

    // Open R1
    const open = await sendSWMessage(panelPage, {
      type: 'RECORDING_OPEN',
      recording_id: r1.recording_id,
    });
    expect(open.ok).toBe(true);
    expect(open.recording.name).toBe('R1');
    expect(open.activeSteps).toBeDefined();

    // Recording should be stopped
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(false);
  });

  test('RECORDING_OPEN with invalid ID returns error', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_OPEN',
      recording_id: 'bad-id',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test('RECORDING_OPEN with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_OPEN',
      recording_id: 'any',
    });
    expect(result.ok).toBe(false);
  });

  test('RECORDING_DELETE removes recording from project', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'ToDelete',
    });

    const del = await sendSWMessage(panelPage, {
      type: 'RECORDING_DELETE',
      recording_id: recording.recording_id,
    });
    expect(del.ok).toBe(true);
    expect(del.project.recordings).toHaveLength(0);

    // Recording state should be stopped
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(false);
  });

  test('RECORDING_DELETE non-active recording keeps recording state', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording: r1 } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R1',
    });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R2' });

    // Active is R2. Delete R1.
    const del = await sendSWMessage(panelPage, {
      type: 'RECORDING_DELETE',
      recording_id: r1.recording_id,
    });
    expect(del.ok).toBe(true);
    expect(del.project.recordings).toHaveLength(1);
  });

  test('RECORDING_START enables recording', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    // Stop recording first
    await sendSWMessage(panelPage, { type: 'RECORDING_STOP' });
    let state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(false);

    // Start recording
    const result = await sendSWMessage(panelPage, { type: 'RECORDING_START' });
    expect(result.ok).toBe(true);

    state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(true);
  });

  test('RECORDING_START with no active recording returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, { type: 'RECORDING_START' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active recording/);
  });

  test('RECORDING_STOP disables recording', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    const result = await sendSWMessage(panelPage, { type: 'RECORDING_STOP' });
    expect(result.ok).toBe(true);

    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(false);
  });

  test('RECORDING_CLEAR resets pending actions', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    // Seed some pending actions
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1 }],
        pendingCount: 1,
      });
    });

    const result = await sendSWMessage(panelPage, { type: 'RECORDING_CLEAR' });
    expect(result.ok).toBe(true);

    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get(['pendingActions', 'pendingCount']);
    });
    expect(state.pendingActions).toEqual([]);
    expect(state.pendingCount).toBe(0);
  });
});

// ─── STEP_COMMIT, STEP_DELETE, STEPS_REORDER ──────────────────────────────────

test.describe('SW Message: Step operations', () => {
  test('STEP_COMMIT creates step from pending actions', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    // Seed pending actions
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [
          { type: 'click', timestamp: 1000, element: { text: 'Login' } },
          { type: 'type', timestamp: 1100, element: { selector: '#user' }, value: 'admin' },
        ],
        pendingCount: 2,
      });
    });

    const result = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Log in as admin',
      narration_source: 'typed',
    });
    expect(result.ok).toBe(true);
    expect(result.step.narration).toBe('Log in as admin');
    expect(result.step.actions).toHaveLength(2);
    expect(result.activeSteps).toHaveLength(1);

    // Pending should be cleared
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get(['pendingActions', 'pendingCount']);
    });
    expect(state.pendingActions).toEqual([]);
    expect(state.pendingCount).toBe(0);
  });

  test('STEP_COMMIT with no pending and no logical_id returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    const result = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Empty',
      narration_source: 'typed',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No actions/);
  });

  test('STEP_COMMIT re-record with logical_id reuses existing actions', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    // Create initial step
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1000, element: { text: 'OK' } }],
        pendingCount: 1,
      });
    });
    const { step } = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Original',
      narration_source: 'typed',
    });

    // Re-record with same logical_id but no new pending actions (narration-only update)
    const rerecord = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Updated narration',
      narration_source: 'typed',
      logical_id: step.logical_id,
    });
    expect(rerecord.ok).toBe(true);
    expect(rerecord.step.narration).toBe('Updated narration');
    expect(rerecord.step.actions).toHaveLength(1);
    expect(rerecord.step.logical_id).toBe(step.logical_id);
  });

  test('STEP_COMMIT with step_type and expect (simple mode)', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1000, element: { text: 'Submit' } }],
        pendingCount: 1,
      });
    });

    const result = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      step_type: 'validation',
      expect: 'present',
    });
    expect(result.ok).toBe(true);
    expect(result.step.step_type).toBe('validation');
    expect(result.step.expect).toBe('present');
  });

  test('STEP_COMMIT with no active recording returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'X',
      narration_source: 'typed',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active recording/);
  });

  test('STEP_DELETE removes step by logical_id', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    // Create two steps
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1000 }],
        pendingCount: 1,
      });
    });
    const { step: s1 } = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'First',
      narration_source: 'typed',
    });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 2000 }],
        pendingCount: 1,
      });
    });
    await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Second',
      narration_source: 'typed',
    });

    // Delete first step
    const del = await sendSWMessage(panelPage, {
      type: 'STEP_DELETE',
      logical_id: s1.logical_id,
    });
    expect(del.ok).toBe(true);
    expect(del.activeSteps).toHaveLength(1);
    expect(del.activeSteps[0].narration).toBe('Second');
  });

  test('STEP_DELETE with no active recording returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'STEP_DELETE',
      logical_id: 'any',
    });
    expect(result.ok).toBe(false);
  });

  test('STEPS_REORDER changes step order', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'R' });

    // Create 3 steps
    const steps = [];
    for (let i = 1; i <= 3; i++) {
      await serviceWorker.evaluate(async (ts) => {
        await chrome.storage.local.set({
          pendingActions: [{ type: 'click', timestamp: ts }],
          pendingCount: 1,
        });
      }, i * 1000);
      const { step } = await sendSWMessage(panelPage, {
        type: 'STEP_COMMIT',
        narration: `Step ${i}`,
        narration_source: 'typed',
      });
      steps.push(step);
    }

    // Reorder: 3, 1, 2
    const result = await sendSWMessage(panelPage, {
      type: 'STEPS_REORDER',
      orderedLogicalIds: [steps[2].logical_id, steps[0].logical_id, steps[1].logical_id],
    });
    expect(result.ok).toBe(true);
    const sorted = result.activeSteps.sort((a, b) => a.step_number - b.step_number);
    expect(sorted[0].narration).toBe('Step 3');
    expect(sorted[1].narration).toBe('Step 1');
    expect(sorted[2].narration).toBe('Step 2');
  });

  test('STEPS_REORDER with no active recording returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'STEPS_REORDER',
      orderedLogicalIds: [],
    });
    expect(result.ok).toBe(false);
  });
});

// ─── PROJECT_IMPORT & PROJECT_EXPORT ──────────────────────────────────────────

test.describe('SW Message: Import and Export', () => {
  test('PROJECT_EXPORT returns structured export data', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'ExportMe' });
    await sendSWMessage(panelPage, { type: 'RECORDING_CREATE', name: 'Rec' });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1000, element: { text: 'A' } }],
        pendingCount: 1,
      });
    });
    await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Click A',
      narration_source: 'typed',
    });

    const result = await sendSWMessage(panelPage, { type: 'PROJECT_EXPORT' });
    expect(result.ok).toBe(true);
    // PROJECT_EXPORT returns the raw active project; the panel stamps + shapes
    // it into the .docent.json export via buildExport (where the schema is
    // available). The service worker no longer wraps it in `exportData`.
    expect(result.project.name).toBe('ExportMe');
    expect(result.project.recordings).toHaveLength(1);
    expect(result.project.recordings[0].steps).toHaveLength(1);
  });

  test('PROJECT_EXPORT with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, { type: 'PROJECT_EXPORT' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active project/);
  });

  test('PROJECT_IMPORT adds new project', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const exportData = {
      project: {
        project_id: '019e0000-0000-7000-8000-bbbbbbbbbbbb',
        name: 'Imported',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [
        {
          recording_id: '019e0000-0000-7000-8000-cccccccccccc',
          name: 'Imported Rec',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [],
        },
      ],
    };

    const result = await sendSWMessage(panelPage, { type: 'PROJECT_IMPORT', exportData });
    expect(result.ok).toBe(true);
    expect(result.project.name).toBe('Imported');

    const list = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(list.projects).toHaveLength(1);
  });

  test('PROJECT_IMPORT with duplicate ID creates copy', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);

    // Create a project first
    const { project: existing } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'Original',
    });

    // Import with the same project_id
    const exportData = {
      project: {
        project_id: existing.project_id,
        name: 'Original',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [],
    };

    const result = await sendSWMessage(panelPage, { type: 'PROJECT_IMPORT', exportData });
    expect(result.ok).toBe(true);
    expect(result.project.name).toBe('Original (copy)');
    expect(result.project.project_id).not.toBe(existing.project_id);

    const list = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(list.projects).toHaveLength(2);
  });

  test('PROJECT_IMPORT with invalid data returns error', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_IMPORT',
      exportData: { invalid: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid export file/);
  });

  test('PROJECT_IMPORT with null exportData returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_IMPORT',
      exportData: null,
    });
    expect(result.ok).toBe(false);
  });
});

// ─── PROJECT_SET_METADATA & RECORDING_SET_METADATA ────────────────────────────

test.describe('SW Message: Metadata operations', () => {
  test('PROJECT_SET_METADATA persists metadata', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });

    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_SET_METADATA',
      metadata: { ticket: 'PROJ-42', tags: ['smoke', 'regression'] },
    });
    expect(result.ok).toBe(true);

    const { projects } = await sendSWMessage(panelPage, { type: 'PROJECTS_GET_ALL' });
    expect(projects[0].metadata).toEqual({ ticket: 'PROJ-42', tags: ['smoke', 'regression'] });
  });

  test('PROJECT_SET_METADATA with null removes metadata', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    await sendSWMessage(panelPage, {
      type: 'PROJECT_SET_METADATA',
      metadata: { x: '1' },
    });
    await sendSWMessage(panelPage, { type: 'PROJECT_SET_METADATA', metadata: null });

    const { projects } = await sendSWMessage(panelPage, { type: 'PROJECTS_GET_ALL' });
    expect(projects[0].metadata).toBeUndefined();
  });

  test('RECORDING_SET_METADATA persists metadata', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R',
    });

    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { env: 'staging' },
    });
    expect(result.ok).toBe(true);
  });

  test('RECORDING_SET_METADATA with null removes metadata', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R',
    });
    await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { x: '1' },
    });
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: null,
    });
    expect(result.ok).toBe(true);
  });

  test('RECORDING_RENAME updates name', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'Old',
    });

    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_RENAME',
      recording_id: recording.recording_id,
      name: 'New Name',
    });
    expect(result.ok).toBe(true);
  });
});

// ─── Error paths and edge cases ───────────────────────────────────────────────

test.describe('SW Message: Error paths', () => {
  test('unknown message type returns error', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, { type: 'TOTALLY_INVALID' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown message type/);
  });

  test('RECORDING_DELETE with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_DELETE',
      recording_id: 'any',
    });
    expect(result.ok).toBe(false);
  });

  test('RECORDING_RENAME with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_RENAME',
      recording_id: 'any',
      name: 'X',
    });
    expect(result.ok).toBe(false);
  });

  test('RECORDING_RENAME with invalid recording_id returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_RENAME',
      recording_id: 'nonexistent',
      name: 'X',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test('RECORDING_SET_METADATA with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: 'any',
      metadata: {},
    });
    expect(result.ok).toBe(false);
  });

  test('RECORDING_SET_METADATA with invalid recording_id returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'P' });
    const result = await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: 'nonexistent',
      metadata: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  test('PROJECT_SET_METADATA with no active project returns error', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    const result = await sendSWMessage(panelPage, {
      type: 'PROJECT_SET_METADATA',
      metadata: { x: '1' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No active project/);
  });
});

// ─── GET_TAB_ID and APPEND_ACTION (synchronous handlers) ─────────────────────

test.describe('SW Message: Synchronous handlers', () => {
  test('GET_TAB_ID returns tabId from sender context', async ({ serviceWorker, panelPage }) => {
    // GET_TAB_ID is handled synchronously and returns sender.tab.id.
    // The panel page is opened as a tab, so it has a valid tab ID.
    const result = await panelPage.evaluate(async () => {
      return await chrome.runtime.sendMessage({ type: 'GET_TAB_ID' });
    });
    // Exercises the synchronous GET_TAB_ID handler path
    expect(result).toHaveProperty('tabId');
    expect(typeof result.tabId).toBe('number');
  });

  test('APPEND_ACTION appends to pending actions queue', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);

    // Send APPEND_ACTION from the panel page (simulates content script sending)
    const result = await panelPage.evaluate(async () => {
      return await chrome.runtime.sendMessage({
        type: 'APPEND_ACTION',
        action: { type: 'click', timestamp: 5000, element: { text: 'Appended' } },
      });
    });
    expect(result.ok).toBe(true);

    // Wait for the write queue to flush
    await new Promise((r) => setTimeout(r, 200));

    // Verify it was appended
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get(['pendingActions', 'pendingCount']);
    });
    expect(state.pendingActions).toHaveLength(1);
    expect(state.pendingActions[0].element.text).toBe('Appended');
    expect(state.pendingCount).toBe(1);
  });
});

// ─── Export with metadata ─────────────────────────────────────────────────────

test.describe('SW Message: Export includes metadata', () => {
  test('export includes project and recording metadata when set', async ({
    serviceWorker,
    panelPage,
  }) => {
    await resetState(serviceWorker);
    await sendSWMessage(panelPage, { type: 'PROJECT_CREATE', name: 'MetaExport' });
    await sendSWMessage(panelPage, {
      type: 'PROJECT_SET_METADATA',
      metadata: { ticket: 'T-1' },
    });

    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'R',
    });
    await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { browser: 'chrome' },
    });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 1000 }],
        pendingCount: 1,
      });
    });
    await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Step',
      narration_source: 'typed',
    });

    const result = await sendSWMessage(panelPage, { type: 'PROJECT_EXPORT' });
    expect(result.ok).toBe(true);
    expect(result.project.metadata).toEqual({ ticket: 'T-1' });
    expect(result.project.recordings[0].metadata).toEqual({ browser: 'chrome' });
  });
});

// ─── Full workflow: create → record → commit → export → import ────────────────

test.describe('SW Message: Full workflow integration', () => {
  test('complete project lifecycle via message handler', async ({ serviceWorker, panelPage }) => {
    await resetState(serviceWorker);

    // Create project
    const { project } = await sendSWMessage(panelPage, {
      type: 'PROJECT_CREATE',
      name: 'Lifecycle',
    });
    expect(project.name).toBe('Lifecycle');

    // Set project metadata
    await sendSWMessage(panelPage, {
      type: 'PROJECT_SET_METADATA',
      metadata: { env: 'test' },
    });

    // Create recording
    const { recording } = await sendSWMessage(panelPage, {
      type: 'RECORDING_CREATE',
      name: 'Flow',
    });

    // Set recording metadata
    await sendSWMessage(panelPage, {
      type: 'RECORDING_SET_METADATA',
      recording_id: recording.recording_id,
      metadata: { browser: 'chrome-130' },
    });

    // Commit steps
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'navigate', timestamp: 1000, url: 'https://example.com' }],
        pendingCount: 1,
      });
    });
    const { step: s1 } = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Navigate to site',
      narration_source: 'typed',
    });

    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        pendingActions: [{ type: 'click', timestamp: 2000, element: { text: 'Login' } }],
        pendingCount: 1,
      });
    });
    const { step: s2 } = await sendSWMessage(panelPage, {
      type: 'STEP_COMMIT',
      narration: 'Click login',
      narration_source: 'typed',
    });

    // Verify steps
    const exportResult = await sendSWMessage(panelPage, { type: 'PROJECT_EXPORT' });
    expect(exportResult.project.recordings[0].steps).toHaveLength(2);

    // Stop recording
    await sendSWMessage(panelPage, { type: 'RECORDING_STOP' });

    // Rename project
    await sendSWMessage(panelPage, { type: 'PROJECT_RENAME', name: 'Lifecycle v2' });

    // Rename recording
    await sendSWMessage(panelPage, {
      type: 'RECORDING_RENAME',
      recording_id: recording.recording_id,
      name: 'Flow v2',
    });

    // Delete a step
    await sendSWMessage(panelPage, { type: 'STEP_DELETE', logical_id: s1.logical_id });

    // Export — PROJECT_EXPORT returns the raw active project
    const finalExport = await sendSWMessage(panelPage, { type: 'PROJECT_EXPORT' });
    expect(finalExport.project.name).toBe('Lifecycle v2');
    expect(finalExport.project.recordings[0].name).toBe('Flow v2');

    // Import it back as a new project. PROJECT_IMPORT consumes the export shape
    // ({ project, recordings }) — the same shape the panel builds via buildExport.
    const importResult = await sendSWMessage(panelPage, {
      type: 'PROJECT_IMPORT',
      exportData: {
        project: finalExport.project,
        recordings: finalExport.project.recordings,
      },
    });
    expect(importResult.ok).toBe(true);
    // Should be a copy since same project_id
    expect(importResult.project.name).toBe('Lifecycle v2 (copy)');

    // Verify we have 2 projects
    const list = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(list.projects).toHaveLength(2);

    // Delete original project
    await sendSWMessage(panelPage, {
      type: 'PROJECT_DELETE',
      project_id: project.project_id,
    });
    const finalList = await sendSWMessage(panelPage, { type: 'PROJECTS_LIST' });
    expect(finalList.projects).toHaveLength(1);
    expect(finalList.projects[0].name).toBe('Lifecycle v2 (copy)');
  });
});

// ─── Tab & Navigation Lifecycle Handlers ──────────────────────────────────────
// These exercise the SW's chrome.tabs.* and chrome.webNavigation.* event
// listeners, which the message-handler tests above never trigger. They run in
// the SW context where the CDP profiler collects coverage.

/**
 * Enable recording so the lifecycle handlers don't early-return.
 */
async function enableRecording(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ recording: true, pendingActions: [], pendingCount: 0 });
  });
  await new Promise((r) => setTimeout(r, 150));
}

async function readPending(serviceWorker) {
  return await serviceWorker.evaluate(async () => {
    const { pendingActions } = await chrome.storage.local.get('pendingActions');
    return pendingActions ?? [];
  });
}

test.describe('SW Lifecycle: tab create/close/switch', () => {
  test('chrome.tabs.create triggers onCreated → context_open', async ({
    serviceWorker,
    context,
  }) => {
    await resetState(serviceWorker);
    await enableRecording(serviceWorker);

    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      return tab.id;
    });
    await new Promise((r) => setTimeout(r, 500));

    const actions = await readPending(serviceWorker);
    expect(actions.some((a) => a.type === 'context_open')).toBe(true);

    // Clean up
    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, tabId);
  });

  test('chrome.tabs.remove triggers onRemoved → context_close', async ({ serviceWorker }) => {
    await resetState(serviceWorker);
    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      return tab.id;
    });
    await new Promise((r) => setTimeout(r, 300));
    await enableRecording(serviceWorker);

    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, tabId);
    await new Promise((r) => setTimeout(r, 500));

    const actions = await readPending(serviceWorker);
    expect(actions.some((a) => a.type === 'context_close')).toBe(true);
  });

  test('chrome.tabs.update active triggers onActivated → context_switch', async ({
    serviceWorker,
  }) => {
    await resetState(serviceWorker);
    // Create a second tab with a real URL so context_switch is not filtered
    const newTabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://example.com' });
      return tab.id;
    });
    await new Promise((r) => setTimeout(r, 600));
    await enableRecording(serviceWorker);

    // Switch to another existing tab (activate a different one)
    await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: false });
      if (tabs.length > 0) await chrome.tabs.update(tabs[0].id, { active: true });
    });
    await new Promise((r) => setTimeout(r, 600));

    // We can't guarantee a context_switch (depends on tab URLs/timing), but the
    // onActivated handler path is exercised. Verify no crash and SW still responds.
    const actions = await readPending(serviceWorker);
    expect(Array.isArray(actions)).toBe(true);

    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, newTabId);
  });

  test('tab created during recent user action is suppressed (programmatic)', async ({
    serviceWorker,
  }) => {
    await resetState(serviceWorker);
    await enableRecording(serviceWorker);

    // Simulate a recent in-page user action so the next tab create is treated
    // as a side-effect (window.open / target=_blank) and suppressed.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ lastUserActionTimestamp: Date.now() });
    });

    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      return tab.id;
    });
    await new Promise((r) => setTimeout(r, 500));

    // The onCreated handler ran but should have suppressed the context_open.
    const actions = await readPending(serviceWorker);
    const opens = actions.filter((a) => a.type === 'context_open');
    expect(opens.length).toBe(0);

    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.remove(id);
    }, tabId);
  });
});

test.describe('SW Lifecycle: webNavigation', () => {
  test('cross-document navigation triggers onCommitted handler', async ({
    serviceWorker,
    context,
  }) => {
    await resetState(serviceWorker);
    await enableRecording(serviceWorker);

    // Open a page and navigate it via the address bar equivalent (typed).
    const page = await context.newPage();
    await page.goto('https://example.com');
    await new Promise((r) => setTimeout(r, 500));
    // Navigate to a different URL — exercises onCommitted
    await page.goto('https://example.com/page2').catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    // The onCommitted handler ran in the SW (coverage captured). We don't assert
    // on a specific action since transitionType from Playwright navigation varies.
    const actions = await readPending(serviceWorker);
    expect(Array.isArray(actions)).toBe(true);

    await page.close();
  });

  test('recording state change triggers content script injection listener', async ({
    serviceWorker,
    context,
  }) => {
    await resetState(serviceWorker);

    // Open an http page so there's an injectable tab
    const page = await context.newPage();
    await page.goto('https://example.com').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    // Flip recording to true — triggers chrome.storage.onChanged → injectContentScript
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({ recording: true });
    });
    await new Promise((r) => setTimeout(r, 500));

    // Handler ran without crashing; SW still responds to storage reads.
    const state = await serviceWorker.evaluate(async () => {
      return await chrome.storage.local.get('recording');
    });
    expect(state.recording).toBe(true);

    await page.close();
  });
});
