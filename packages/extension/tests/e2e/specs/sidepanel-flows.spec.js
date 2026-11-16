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
import { writeRawDump } from '../../../../shared/tests/support/coverage-run.js';

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
    writeRawDump(rawDir, 'panel-flows', coverageCounter++, coverage);
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
      panelPage.waitForEvent('download', { timeout: 5000 }),
      panelPage.click('#btn-export-project'),
    ]);
    // The file is named after the project, then a timestamp.
    expect(download.suggestedFilename()).toMatch(/^Export_\d+\.docent\.json$/);
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

// ─── Two panels open ──────────────────────────────────────────────────────────

// Regression: #661 — with two side panel pages open, a project created in the
// second moved the service worker's worker-wide active project and recording,
// and the first panel's project- and recording-scoped actions then acted on
// the project and recording the second panel opened instead of the ones the
// first panel shows.
// https://github.com/Arsarneq/docent/issues/661
test.describe('Side Panel — Two panels open', () => {
  async function createProject(page, name) {
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', name);
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  }

  async function createRecording(page, name) {
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', name);
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  }

  /** Open a second panel page and create a project and a recording in it. */
  async function openElsewhere(context, extensionId) {
    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await second.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await createProject(second, 'Opened elsewhere');
    await createRecording(second, 'Flow B');
    return second;
  }

  /** The stored project by name, with each recording's active step count. */
  function storedProject(serviceWorker, name) {
    return serviceWorker.evaluate(async (projectName) => {
      const { projects } = await chrome.storage.local.get('projects');
      const project = projects.find((p) => p.name === projectName);
      if (!project) return null;
      const activeCount = (steps) => {
        const latest = new Map();
        for (const s of steps) {
          const seen = latest.get(s.logical_id);
          if (!seen || s.uuid > seen.uuid) latest.set(s.logical_id, s);
        }
        return [...latest.values()].filter((s) => !s.deleted).length;
      };
      return {
        name: project.name,
        recordings: project.recordings.map((r) => ({
          name: r.name,
          activeSteps: activeCount(r.steps),
        })),
      };
    }, name);
  }

  const capturing = (serviceWorker) =>
    serviceWorker.evaluate(async () => (await chrome.storage.local.get('recording')).recording);

  const pendingLength = (serviceWorker) =>
    serviceWorker.evaluate(
      async () => ((await chrome.storage.local.get('pendingActions')).pendingActions ?? []).length,
    );

  const CLICK = {
    type: 'click',
    timestamp: 1000,
    capture_mode: 'dom',
    context_id: 1,
    element: { text: 'X' },
  };

  test('regression_661_project_rename_renames_the_project_open_in_its_panel', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    const second = await openElsewhere(context, extensionId);

    panelPage.once('dialog', (d) => d.accept('Renamed here'));
    await panelPage.click('#project-title');
    await expect(panelPage.locator('#project-title')).toHaveText('Renamed here');

    // The renamed project is the one this panel shows, which has no recording.
    expect((await storedProject(serviceWorker, 'Renamed here'))?.recordings).toEqual([]);
    expect(await storedProject(serviceWorker, 'Opened elsewhere')).not.toBeNull();
    await second.close();
  });

  test('regression_661_new_recording_is_created_in_the_project_open_in_its_panel', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    const second = await openElsewhere(context, extensionId);

    await createRecording(panelPage, 'Flow A');
    await expect(panelPage.locator('#bc-project')).toHaveText('Shown here');

    const shown = await storedProject(serviceWorker, 'Shown here');
    expect(shown.recordings.map((r) => r.name)).toEqual(['Flow A']);
    const elsewhere = await storedProject(serviceWorker, 'Opened elsewhere');
    expect(elsewhere.recordings.map((r) => r.name)).toEqual(['Flow B']);
    await second.close();
  });

  test('regression_661_recording_opens_from_the_project_open_in_its_panel', async ({
    panelPage,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    const second = await openElsewhere(context, extensionId);

    await panelPage.click('#recording-list [data-action="open"]');
    await expect(panelPage.locator('#view-recording')).toBeVisible();
    await expect(panelPage.locator('#recording-title')).toHaveText('Flow A');
    await second.close();
  });

  test('regression_661_step_delete_deletes_the_step_in_the_recording_open_in_its_panel', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'To delete');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    await panelPage.click('#btn-commit-step');
    await expect(panelPage.locator('#step-count')).toHaveText('1');
    const second = await openElsewhere(context, extensionId);

    panelPage.once('dialog', (d) => d.accept());
    await panelPage.click('#step-list [data-action="delete"]');
    await expect(panelPage.locator('#step-count')).toHaveText('0');

    const shown = await storedProject(serviceWorker, 'Shown here');
    expect(shown.recordings[0].activeSteps).toBe(0);
    await second.close();
  });

  /**
   * The text of the next dialog the page opens, accepted. The action is
   * awaited only once the dialog is accepted: an open alert holds the page,
   * so a click that opens one does not settle before it closes.
   */
  async function nextDialogText(page, act) {
    const shown = page.waitForEvent('dialog', { timeout: 5000 });
    const acted = act();
    const dialog = await shown;
    const text = dialog.message();
    await dialog.accept();
    await acted;
    return text;
  }

  // The expected outcome follows the design in which a step commit naming a
  // recording other than the one capture goes to is refused.
  test('regression_661_done_this_step_commits_nothing_into_the_recording_open_elsewhere', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    const second = await openElsewhere(context, extensionId);

    // An action captured for the recording the second panel opened.
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'Committed in the first panel');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-commit-step'))).toBe(
      'Commit failed: Not the active recording',
    );
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    expect(await capturing(serviceWorker)).toBe(true);

    const elsewhere = await storedProject(serviceWorker, 'Opened elsewhere');
    expect(elsewhere.recordings[0].activeSteps).toBe(0);
    const shown = await storedProject(serviceWorker, 'Shown here');
    expect(shown.recordings[0].activeSteps).toBe(0);
    expect(await pendingLength(serviceWorker)).toBe(1);
    await second.close();
  });

  test('regression_661_pause_of_a_recording_no_longer_capturing_is_refused', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    const second = await openElsewhere(context, extensionId);

    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-toggle-recording'))).toBe(
      'Pause failed: Not the active recording',
    );
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    // The other panel's capture goes on.
    expect(await capturing(serviceWorker)).toBe(true);
    await second.close();
  });

  test('regression_661_resume_of_a_recording_no_longer_active_is_refused', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await panelPage.click('#btn-toggle-recording');
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    const second = await openElsewhere(context, extensionId);
    await second.click('#btn-toggle-recording');
    await expect(second.locator('#recording-badge')).toHaveText('Paused');

    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-toggle-recording'))).toBe(
      'Resume failed: Not the active recording',
    );
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    expect(await capturing(serviceWorker)).toBe(false);
    await second.close();
  });

  test('regression_661_rerecord_in_a_recording_no_longer_active_is_refused', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'Original');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    await panelPage.click('#btn-commit-step');
    await expect(panelPage.locator('#step-count')).toHaveText('1');
    const second = await openElsewhere(context, extensionId);
    await simulateActions(serviceWorker, [CLICK]);

    expect(
      await nextDialogText(panelPage, () =>
        panelPage.locator('#step-list [data-action="edit"]').first().click(),
      ),
    ).toBe('Re-record failed: Not the active recording');
    await expect(panelPage.locator('#rerecord-banner')).toBeHidden();
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    // The action captured for the other panel's recording is kept.
    expect(await pendingLength(serviceWorker)).toBe(1);
    expect(await capturing(serviceWorker)).toBe(true);
    await second.close();
  });

  test('regression_661_opening_a_recording_another_panel_deleted_says_so', async ({
    panelPage,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await second.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await second.click('#project-list [data-action="open"]');
    await second.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    second.once('dialog', (d) => d.accept());
    await second.click('#recording-list [data-action="delete"]');
    await expect(second.locator('#recordings-empty')).toBeVisible();

    expect(
      await nextDialogText(panelPage, () =>
        panelPage.click('#recording-list [data-action="open"]'),
      ),
    ).toBe('Open failed: Recording not found');
    await expect(panelPage.locator('#view-project')).toBeVisible();
    await second.close();
  });

  test('regression_661_breadcrumb_in_one_panel_leaves_capture_in_the_other_running', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    const second = await openElsewhere(context, extensionId);
    expect(await capturing(serviceWorker)).toBe(true);

    await panelPage.click('#bc-projects');
    await panelPage.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    expect(await capturing(serviceWorker)).toBe(true);
    await second.close();
  });

  test('regression_661_project_created_in_another_panel_stops_capture_and_pause_still_answers', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    expect(await capturing(serviceWorker)).toBe(true);

    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await second.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await createProject(second, 'Created elsewhere');
    // No recording is active, so no capture runs.
    await expect.poll(() => capturing(serviceWorker)).toBe(false);

    const dialogs = [];
    panelPage.on('dialog', (d) => {
      dialogs.push(d.message());
      d.accept();
    });
    await panelPage.click('#btn-toggle-recording');
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    expect(dialogs).toEqual([]);
    expect(await capturing(serviceWorker)).toBe(false);
    await second.close();
  });

  test('regression_661_refused_rerecord_commit_keeps_the_typed_narration', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'Original');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    await panelPage.click('#btn-commit-step');
    await expect(panelPage.locator('#step-count')).toHaveText('1');
    await panelPage.locator('#step-list [data-action="edit"]').first().click();
    await expect(panelPage.locator('#rerecord-banner')).toBeVisible();

    const second = await openElsewhere(context, extensionId);
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'Typed again');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();

    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-commit-step'))).toBe(
      'Commit failed: Not the active recording',
    );
    await expect(panelPage.locator('#rerecord-banner')).toBeHidden();
    await expect(panelPage.locator('#narration-input')).toHaveValue('Typed again');
    await second.close();
  });

  test('a resume refused because the recording is gone meanwhile leaves the panel paused', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await panelPage.click('#btn-toggle-recording');
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    // The recording leaves the stored projects while capture is off, as a
    // sync that accepts its deletion leaves it.
    await panelPage.evaluate(async () => {
      const { projects } = await chrome.runtime.sendMessage({ type: 'PROJECTS_GET_ALL' });
      const without = projects.map((p) => ({ ...p, recordings: [] }));
      await chrome.runtime.sendMessage({ type: 'PROJECTS_SET', projects: without });
    });

    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-toggle-recording'))).toBe(
      'Resume failed: No active recording',
    );
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
    expect(await capturing(serviceWorker)).toBe(false);
  });

  /** Accept every dialog the page opens from now on, keeping the alerts' texts. */
  function failedAlerts(page) {
    const texts = [];
    page.on('dialog', (d) => {
      if (/ failed: /.test(d.message())) texts.push(d.message());
      d.accept();
    });
    return texts;
  }

  /** Open a second panel page on the named project, as a person opens it from the list. */
  async function openSameProject(context, extensionId, name) {
    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await second.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await second
      .locator('#project-list li', { hasText: name })
      .locator('[data-action="open"]')
      .click();
    await second.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    return second;
  }

  /** Delete the open project's only recording from that page. */
  async function deleteTheRecording(page) {
    page.once('dialog', (d) => d.accept());
    await page.click('#recording-list [data-action="delete"]');
    await expect(page.locator('#recordings-empty')).toBeVisible();
  }

  async function commitNarrated(page, serviceWorker, narration, count) {
    await simulateActions(serviceWorker, [CLICK]);
    await page.fill('#narration-input', narration);
    await expect(page.locator('#btn-commit-step')).toBeEnabled();
    await page.click('#btn-commit-step');
    await expect(page.locator('#step-count')).toHaveText(String(count));
  }

  test('regression_661_deleting_a_recording_another_panel_deleted_says_so_and_shows_the_project_as_it_is', async ({
    panelPage,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await panelPage.click('#bc-project');
    await panelPage.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    const second = await openSameProject(context, extensionId, 'Shown here');
    await expect(second.locator('#recording-list li')).toHaveCount(1);
    await deleteTheRecording(panelPage);

    const alerts = failedAlerts(second);
    await second.click('#recording-list [data-action="delete"]');
    await expect.poll(() => alerts).toEqual(['Delete failed: Recording not found']);
    await expect(second.locator('#view-project')).toBeVisible();
    await expect(second.locator('#project-title')).toHaveText('Shown here');
    await expect(second.locator('#recordings-empty')).toBeVisible();
    await second.close();
  });

  test('regression_661_deleting_a_step_of_a_recording_deleted_elsewhere_says_so', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await commitNarrated(panelPage, serviceWorker, 'Kept', 1);
    const second = await openSameProject(context, extensionId, 'Shown here');
    await deleteTheRecording(second);

    const alerts = failedAlerts(panelPage);
    await panelPage.click('#step-list [data-action="delete"]');
    await expect.poll(() => alerts).toEqual(['Delete failed: Recording not found']);
    await expect(panelPage.locator('#view-recording')).toBeVisible();
    await expect(panelPage.locator('#step-count')).toHaveText('1');
    await expect(panelPage.locator('#step-list .step-item')).toHaveCount(1);
    await second.close();
  });

  test('regression_661_reordering_the_steps_of_a_recording_deleted_elsewhere_says_so', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await commitNarrated(panelPage, serviceWorker, 'First', 1);
    await commitNarrated(panelPage, serviceWorker, 'Second', 2);
    const second = await openSameProject(context, extensionId, 'Shown here');
    await deleteTheRecording(second);

    const alerts = failedAlerts(panelPage);
    await panelPage.locator('.step-item').nth(1).dragTo(panelPage.locator('.step-item').nth(0));
    await expect.poll(() => alerts).toEqual(['Reorder failed: Recording not found']);
    // The list shows the order the steps still have.
    const steps = panelPage.locator('.step-narration');
    await expect(steps.nth(0)).toContainText('First');
    await expect(steps.nth(1)).toContainText('Second');
    await second.close();
  });

  test('regression_661_creating_a_recording_in_a_project_deleted_elsewhere_says_so', async ({
    panelPage,
    serviceWorker,
    context,
    extensionId,
  }) => {
    await createProject(panelPage, 'Shown here');
    const second = await context.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
    await second.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    second.once('dialog', (d) => d.accept());
    await second
      .locator('#project-list li', { hasText: 'Shown here' })
      .locator('[data-action="delete"]')
      .click();
    await expect(second.locator('#project-list li', { hasText: 'Shown here' })).toHaveCount(0);

    const alerts = failedAlerts(panelPage);
    await panelPage.click('#btn-new-recording');
    await panelPage.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await panelPage.fill('#new-recording-name', 'Flow A');
    await panelPage.click('#btn-new-recording-create');
    await expect.poll(() => alerts).toEqual(['Create failed: Project not found']);
    // The project is gone, so the panel shows the projects list as it is.
    await expect(panelPage.locator('#view-projects')).toBeVisible();
    await expect(panelPage.locator('#project-list li', { hasText: 'Shown here' })).toHaveCount(0);
    expect(await capturing(serviceWorker)).toBe(false);
    await second.close();
  });

  test('regression_661_a_restart_refused_after_a_commit_leaves_the_panel_paused', async ({
    panelPage,
    serviceWorker,
  }) => {
    await createProject(panelPage, 'Shown here');
    await createRecording(panelPage, 'Flow A');
    await simulateActions(serviceWorker, [CLICK]);
    await panelPage.fill('#narration-input', 'Committed');
    await expect(panelPage.locator('#btn-commit-step')).toBeEnabled();
    // The service worker refuses the restart that follows the commit, as it
    // does when another panel makes its own recording the active one between
    // the two; the panel's messages are answered here the way it would.
    await panelPage.evaluate(() => {
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message) =>
        message.type === 'RECORDING_START'
          ? Promise.resolve({ ok: false, error: 'Not the active recording' })
          : sendMessage(message);
    });

    expect(await nextDialogText(panelPage, () => panelPage.click('#btn-commit-step'))).toBe(
      'Resume failed: Not the active recording',
    );
    await expect(panelPage.locator('#step-count')).toHaveText('1');
    await expect(panelPage.locator('#recording-badge')).toHaveText('Paused');
  });
});
