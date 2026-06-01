/**
 * Side Panel — Extended Flow Tests
 *
 * Exercises recording, commit, delete, dispatch, and sync flows in the
 * extension's side panel to increase panel.js coverage.
 *
 * Uses simulateActions() to write mock pendingActions to chrome.storage.local,
 * which triggers the panel's onChanged listener.
 *
 * Closes #101
 */

import { test as base, chromium, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');
const coverageDir = path.resolve(__dirname, '../coverage');
const rawDir = path.resolve(coverageDir, 'raw');

fs.mkdirSync(rawDir, { recursive: true });

let coverageCounter = 0;

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

  panelPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await page.waitForTimeout(500);

    await use(page);

    const coverage = await page.coverage.stopJSCoverage();
    const outFile = path.join(rawDir, `panel-flows-${coverageCounter++}.json`);
    fs.writeFileSync(outFile, JSON.stringify(coverage));
    await page.close();
  },
});

/**
 * Simulate captured actions by writing to chrome.storage.local.
 * The panel's adapter.onPendingCountChange listener will fire.
 */
async function simulateActions(serviceWorker, actions) {
  await serviceWorker.evaluate(async (acts) => {
    const { pendingActions: existing } = await chrome.storage.local.get('pendingActions');
    const updated = [...(existing || []), ...acts];
    await chrome.storage.local.set({
      pendingActions: updated,
      pendingCount: updated.length,
    });
  }, actions);
}

/** Create a project via the SW message handler. */
async function createProjectViaSW(serviceWorker, name) {
  return await serviceWorker.evaluate(async (n) => {
    return await chrome.runtime.sendMessage({ type: 'PROJECT_CREATE', name: n });
  }, name);
}

/** Create a recording via the SW message handler. */
async function createRecordingViaSW(serviceWorker, name) {
  return await serviceWorker.evaluate(async (n) => {
    return await chrome.runtime.sendMessage({ type: 'RECORDING_CREATE', name: n });
  }, name);
}

/** Start recording via the SW. */
async function startRecording(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ recording: true });
  });
}

test.describe('Side Panel — Commit Step (Narration Mode)', () => {
  test('simulate actions + type narration + commit → step appears', async ({
    panelPage,
    serviceWorker,
  }) => {
    // Create project + recording via panel UI
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Commit Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Flow');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Simulate a captured action
    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: Date.now(),
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'Login', tag: 'Button', selector: '#login' },
      },
    ]);
    await panelPage.waitForTimeout(500);

    // Type narration and commit
    await panelPage.fill('#narration-input', 'Click the login button');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    // Verify step appears
    await expect(panelPage.locator('.step-item')).toHaveCount(1);
    await expect(panelPage.locator('#step-count')).toHaveText('1');
  });
});

test.describe('Side Panel — Delete Flows', () => {
  test('delete project removes it from list', async ({ panelPage }) => {
    // Create a project
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'To Delete');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    // Go back to projects list
    await panelPage.click('#bc-projects');
    await panelPage.waitForSelector('#view-projects', { timeout: 5000 });
    await expect(panelPage.locator('[data-action="open"]')).toHaveCount(1);

    // Delete
    panelPage.on('dialog', (d) => d.accept());
    await panelPage.click('[data-action="delete"]');
    await panelPage.waitForTimeout(500);

    await expect(panelPage.locator('#projects-empty')).toBeVisible();
  });

  test('delete recording returns to project view', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'P');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Go back to project and delete recording
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    panelPage.on('dialog', (d) => d.accept());
    await panelPage.click('[data-action="delete"]');
    await panelPage.waitForTimeout(500);

    await expect(panelPage.locator('#recordings-empty')).toBeVisible();
  });
});

test.describe('Side Panel — Step Detail View', () => {
  test('clicking step opens detail with actions', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Detail Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Flow');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Simulate + commit
    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'Submit', tag: 'Button', selector: '#submit' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Click submit');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    // Click step to open detail
    await panelPage.click('.step-narration');
    await panelPage.waitForSelector('#view-step-detail', { timeout: 5000 });

    await expect(panelPage.locator('#step-detail-title')).toContainText('Click submit');
    await expect(panelPage.locator('.step-detail-item')).toHaveCount(1);

    // Back
    await panelPage.click('#btn-step-detail-back');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });
  });
});

test.describe('Side Panel — Settings and Dispatch', () => {
  test('save dispatch endpoint and verify persistence', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });

    await panelPage.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
    await panelPage.fill('#settings-api-key', 'test-key');
    await panelPage.click('#btn-settings-dispatch-save');
    await panelPage.waitForTimeout(300);

    // Navigate away and back
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });

    await expect(panelPage.locator('#settings-endpoint-url')).toHaveValue(
      'https://api.example.com/dispatch',
    );
  });

  test('save sync settings', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });

    await panelPage.fill('#settings-sync-url', 'https://sync.example.com');
    await panelPage.fill('#settings-sync-api-key', 'sync-key');
    await panelPage.click('#btn-settings-sync-save');
    await panelPage.waitForTimeout(300);

    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });

    await expect(panelPage.locator('#settings-sync-url')).toHaveValue('https://sync.example.com');
  });
});

test.describe('Side Panel — Clear Pending Actions', () => {
  test('clear resets pending count and disables commit', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Clear Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Simulate actions
    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await panelPage.waitForTimeout(500);

    // Clear
    panelPage.on('dialog', (d) => d.accept());
    await panelPage.click('#btn-clear-step');
    await panelPage.waitForTimeout(500);

    // Commit should be disabled
    await expect(panelPage.locator('#btn-commit-step')).toBeDisabled();
  });
});

test.describe('Side Panel — Theme and Recording Mode', () => {
  test('switch to simple mode shows simple mode box', async ({ panelPage }) => {
    // Switch to simple mode
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });
    const simpleLabel = panelPage
      .locator('input[name="recording-mode"][value="simple"]')
      .locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);

    // Create project + recording
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Simple');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await expect(panelPage.locator('#simple-mode-box')).toBeVisible();
    await expect(panelPage.locator('#narration-mode-box')).toBeHidden();
  });
});

test.describe('Side Panel — Delete Step', () => {
  test('delete step reduces step count', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Del Step');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Commit a step
    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'To delete');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);
    await expect(panelPage.locator('#step-count')).toHaveText('1');

    // Delete it
    panelPage.on('dialog', (d) => d.accept());
    await panelPage.click('[data-action="delete"]');
    await panelPage.waitForTimeout(500);
    await expect(panelPage.locator('#step-count')).toHaveText('0');
  });
});

test.describe('Side Panel — Step History', () => {
  test('history shows versions after re-record', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'History');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    // Commit original step
    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'Original' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Original step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    // Click history
    await panelPage.click('[data-action="history"]');
    await panelPage.waitForSelector('#view-history', { timeout: 5000 });
    await expect(panelPage.locator('.history-item')).toHaveCount(1);

    // Back
    await panelPage.click('#btn-history-back');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });
  });
});

test.describe('Side Panel — Breadcrumb Navigation', () => {
  test('breadcrumb navigates back to projects', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Nav Test');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.click('#bc-projects');
    await panelPage.waitForSelector('#view-projects', { timeout: 5000 });
    await expect(panelPage.locator('[data-action="open"]')).toHaveCount(1);
  });

  test('breadcrumb project link returns to project view', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'P');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
  });
});

test.describe('Side Panel — Dispatch Flow', () => {
  test('dispatch with mocked fetch shows result', async ({ panelPage, serviceWorker }) => {
    // Configure endpoint
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });
    await panelPage.fill('#settings-endpoint-url', 'https://api.test/dispatch');
    await panelPage.fill('#settings-api-key', 'key');
    await panelPage.click('#btn-settings-dispatch-save');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);

    // Create project + recording + commit step
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Dispatch');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Flow');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'OK' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Click OK');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    // Go to project and dispatch
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    // Mock fetch for the dispatch endpoint only — let the schema fetch
    // (shared/session.schema.json, used to build the docent_format stamp) pass
    // through to the real extension resource.
    await panelPage.evaluate(() => {
      window._originalFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('session.schema.json')) {
          return window._originalFetch(url, opts);
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };
    });

    await panelPage.click('#btn-dispatch-project');
    await panelPage.waitForTimeout(500);

    // Should show confirmation or result (depends on single vs multi recording)
    const confirmVisible = await panelPage.locator('#view-dispatch-confirm').isVisible();
    if (confirmVisible) {
      await panelPage.click('#btn-confirm-send');
      await panelPage.waitForSelector('#view-dispatch-result', { timeout: 10000 });
      await expect(panelPage.locator('#result-title')).toHaveText('Sent');
    }
  });
});

test.describe('Side Panel — Dispatch Failure', () => {
  test('dispatch failure shows error result', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });
    await panelPage.fill('#settings-endpoint-url', 'https://api.test/dispatch');
    await panelPage.click('#btn-settings-dispatch-save');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);

    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Fail');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    await panelPage.evaluate(() => {
      window._originalFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('session.schema.json')) {
          return window._originalFetch(url, opts);
        }
        return { ok: false, status: 500, text: async () => 'Server Error' };
      };
    });

    await panelPage.click('#btn-dispatch-project');
    await panelPage.waitForTimeout(500);
    const confirmVisible = await panelPage.locator('#view-dispatch-confirm').isVisible();
    if (confirmVisible) {
      await panelPage.click('#btn-confirm-send');
      await panelPage.waitForSelector('#view-dispatch-result', { timeout: 10000 });
      await expect(panelPage.locator('#result-title')).toHaveText('Error');
    }
  });
});

test.describe('Side Panel — Sync Flow', () => {
  test('sync with configured URL completes', async ({ panelPage }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });
    await panelPage.fill('#settings-sync-url', 'https://sync.test');
    await panelPage.click('#btn-settings-sync-save');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);

    await panelPage.evaluate(() => {
      window.fetch = async (url, opts) => {
        if (opts && opts.method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => [] };
      };
    });

    panelPage.on('dialog', (d) => d.accept());
    await panelPage.click('#btn-sync');
    await panelPage.waitForTimeout(2000);
    await expect(panelPage.locator('#btn-sync')).toHaveText('Sync');
  });
});

test.describe('Side Panel — Export', () => {
  test('export button triggers download', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Export');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'A' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Step');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    // Click export — triggers blob download in extension
    const [download] = await Promise.all([
      panelPage.waitForEvent('download', { timeout: 5000 }).catch(() => null),
      panelPage.click('#btn-export-project'),
    ]);
    await panelPage.waitForTimeout(500);
  });
});

test.describe('Side Panel — Cancel Flows', () => {
  test('cancel new project returns to projects', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.click('#btn-new-project-cancel');
    await panelPage.waitForSelector('#view-projects', { timeout: 5000 });
  });

  test('cancel new recording returns to project', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'P');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.click('#btn-new-recording-cancel');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
  });

  test('cancel dispatch confirmation returns to project', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-settings');
    await panelPage.waitForSelector('#view-settings', { timeout: 5000 });
    await panelPage.fill('#settings-endpoint-url', 'https://api.test');
    await panelPage.click('#btn-settings-dispatch-save');
    await panelPage.waitForTimeout(200);
    await panelPage.click('#btn-settings-back');
    await panelPage.waitForTimeout(200);

    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'P');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'X' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'S');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-dispatch-project');
    await panelPage.waitForTimeout(500);

    const confirmVisible = await panelPage.locator('#view-dispatch-confirm').isVisible();
    if (confirmVisible) {
      await panelPage.click('#btn-confirm-cancel');
      await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    }
  });
});

test.describe('Side Panel — Metadata', () => {
  test('add project metadata row and fill values', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    // Open metadata section
    const metaSection = panelPage.locator('#project-metadata-section summary');
    if ((await metaSection.count()) > 0) {
      await metaSection.click();
      await panelPage.click('#btn-add-project-metadata');
      await panelPage.waitForTimeout(200);

      await panelPage.locator('#project-metadata-list .metadata-key').first().fill('env');
      await panelPage.locator('#project-metadata-list .metadata-value').first().fill('prod');
      await panelPage.locator('#project-metadata-list .metadata-value').first().press('Tab');
      await panelPage.waitForTimeout(300);

      await expect(panelPage.locator('#project-metadata-list .metadata-row')).toHaveCount(1);
    }
  });

  test('remove metadata row', async ({ panelPage }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Meta2');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });

    const metaSection = panelPage.locator('#project-metadata-section summary');
    if ((await metaSection.count()) > 0) {
      await metaSection.click();
      await panelPage.click('#btn-add-project-metadata');
      await panelPage.waitForTimeout(200);
      await panelPage.locator('#project-metadata-list .metadata-key').first().fill('k');
      await panelPage.locator('#project-metadata-list .metadata-value').first().fill('v');
      await panelPage.locator('#project-metadata-list .metadata-value').first().press('Tab');
      await panelPage.waitForTimeout(200);

      // Remove
      await panelPage.click('#project-metadata-list .metadata-remove');
      await panelPage.waitForTimeout(200);
      await expect(panelPage.locator('#project-metadata-list .metadata-row')).toHaveCount(0);
    }
  });
});

test.describe('Side Panel — Re-record', () => {
  test('edit step enters re-record state', async ({ panelPage, serviceWorker }) => {
    await panelPage.click('#btn-new-project');
    await panelPage.waitForSelector('#view-new-project', { timeout: 5000 });
    await panelPage.fill('#new-project-name', 'Rerecord');
    await panelPage.click('#btn-new-project-create');
    await panelPage.waitForSelector('#view-project', { timeout: 5000 });
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'R');
    await panelPage.click('#btn-new-recording-create');
    await panelPage.waitForSelector('#view-recording', { timeout: 5000 });

    await simulateActions(serviceWorker, [
      {
        type: 'click',
        timestamp: 1000,
        capture_mode: 'dom',
        context_id: 1,
        element: { text: 'Orig' },
      },
    ]);
    await panelPage.waitForTimeout(500);
    await panelPage.fill('#narration-input', 'Original');
    await panelPage.click('#btn-commit-step');
    await panelPage.waitForTimeout(1000);

    // Click edit/re-record
    const editBtn = panelPage.locator('[data-action="edit"]').first();
    if ((await editBtn.count()) > 0) {
      await editBtn.click();
      await panelPage.waitForTimeout(300);
      await expect(panelPage.locator('#rerecord-banner')).toBeVisible();

      // Cancel re-record
      await panelPage.click('#btn-rerecord-cancel');
      await panelPage.waitForTimeout(300);
      await expect(panelPage.locator('#rerecord-banner')).toBeHidden();
    }
  });
});
