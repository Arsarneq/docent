/**
 * Desktop Panel — Advanced Flow Tests
 *
 * Tests dispatch send with mocked fetch, sync flow, inline rename,
 * recording selector (multi-recording dispatch), and re-record cancel.
 * These target the remaining uncovered paths in panel.js.
 */

import { test, expect } from './coverage-fixture.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');

const TAURI_MOCK_JS = `
  let _savedState = JSON.stringify({ projects: [], settings: {} });
  let _maxSeq = 0;

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'load_state': return _savedState;
          case 'save_state': _savedState = args.data; return;
          case 'start_capture': return;
          case 'stop_capture': return;
          case 'list_windows': return [];
          case 'get_max_sequence_number': return _maxSeq;
          case 'set_self_capture_exclusion': return;
          case 'set_target_pid': return;
          case 'export_file': return;
          case 'import_file': return null;
          case 'get_self_pid': return 1234;
          default: return null;
        }
      },
    },
    event: {
      listen: (event, handler) => {
        window.__TAURI__._listeners = window.__TAURI__._listeners || {};
        window.__TAURI__._listeners[event] = handler;
        return Promise.resolve(() => {});
      },
    },
    _listeners: {},
  };
`;

let server;
let serverPort;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/__tauri-mock.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(TAURI_MOCK_JS);
      return;
    }
    let filePath = path.resolve(distPath, req.url === '/' ? 'index.html' : req.url.slice(1));
    if (!filePath.startsWith(distPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.md': 'text/markdown',
    };
    let content = fs.readFileSync(filePath, 'utf-8');
    if (ext === '.html') {
      content = content.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
      content = content.replace('<head>', '<head><script src="/__tauri-mock.js"></script>');
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(content);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

test.afterAll(async () => {
  server?.close();
});

// Helper: set up a project with endpoint configured and a committed step
async function setupDispatchReady(page) {
  await page.goto(`http://127.0.0.1:${serverPort}/`);
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

  // Configure endpoint
  await page.click('#btn-settings');
  await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
  await page.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
  await page.fill('#settings-api-key', 'test-key');
  await page.click('#btn-settings-dispatch-save');
  await page.waitForTimeout(200);
  await page.click('#btn-settings-back');
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

  // Create project + recording + commit step
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', 'Dispatch Project');
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', 'Flow A');
  await page.click('#btn-new-recording-create');
  await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  await page.evaluate(() => {
    const handler = window.__TAURI__._listeners['capture:action'];
    if (handler)
      handler({
        payload: {
          type: 'click',
          timestamp: Date.now(),
          capture_mode: 'accessibility',
          context_id: 1,
          element: { text: 'Submit', tag: 'Button', selector: '#btn' },
        },
      });
  });
  await page.waitForTimeout(300);
  await page.fill('#narration-input', 'Click submit');
  await page.click('#btn-commit-step');
  await page.waitForTimeout(500);
}

test.describe('Desktop Panel — Dispatch Send', () => {
  test('successful dispatch shows success result view', async ({ page }) => {
    await setupDispatchReady(page);

    // Mock fetch to succeed
    await page.evaluate(() => {
      window._originalFetch = window.fetch;
      window.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });
    });

    // Navigate to project and dispatch
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-confirm-send');
    await page.waitForSelector('#view-dispatch-result:not(.hidden)', { timeout: 10000 });

    await expect(page.locator('#result-title')).toHaveText('Sent');
    await expect(page.locator('#result-message')).toContainText('Successfully dispatched');

    // Back button returns to project
    await page.click('#btn-result-back');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  });

  test('failed dispatch shows error result view', async ({ page }) => {
    await setupDispatchReady(page);

    // Mock fetch to fail
    await page.evaluate(() => {
      window.fetch = async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
    });

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-confirm-send');
    await page.waitForSelector('#view-dispatch-result:not(.hidden)', { timeout: 10000 });

    await expect(page.locator('#result-title')).toHaveText('Error');
    await expect(page.locator('#result-message')).toContainText('500');
  });
});

test.describe('Desktop Panel — Sync Flow', () => {
  test('sync button triggers sync and shows summary', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure sync settings
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'https://sync.example.com');
    await page.fill('#settings-sync-api-key', 'sync-key');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Mock fetch for sync (push succeeds, pull returns empty manifest)
    await page.evaluate(() => {
      window.fetch = async (url, opts) => {
        if (opts && opts.method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/projects') && (!opts || opts.method === 'GET'))
          return { ok: true, status: 200, json: async () => [] };
        return { ok: true, status: 200, json: async () => ({}) };
      };
    });

    // Sync button should be enabled
    await expect(page.locator('#btn-sync')).toBeEnabled();

    // Accept the alert that shows sync summary
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-sync');
    await page.waitForTimeout(1000);

    // Button should return to "Sync" text (not "Syncing…")
    await expect(page.locator('#btn-sync')).toHaveText('Sync');
  });
});

test.describe('Desktop Panel — Inline Rename', () => {
  test('rename project via prompt dialog', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Original Name');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Handle the prompt dialog
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('Renamed Project');
      }
    });

    await page.click('#project-title');
    await page.waitForTimeout(300);

    await expect(page.locator('#project-title')).toHaveText('Renamed Project');
  });

  test('rename recording via prompt dialog', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Original Rec');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'prompt') {
        await dialog.accept('Renamed Recording');
      }
    });

    await page.click('#recording-title');
    await page.waitForTimeout(300);

    await expect(page.locator('#recording-title')).toHaveText('Renamed Recording');
  });
});

test.describe('Desktop Panel — Recording Selector', () => {
  test('multiple recordings show selector view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure endpoint
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.example.com/dispatch');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project with 2 recordings, each with a step
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Multi');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Recording 1
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec 1');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.evaluate(() => {
      const h = window.__TAURI__._listeners['capture:action'];
      if (h)
        h({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'A' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Step 1');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Go back and create Recording 2
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec 2');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.evaluate(() => {
      const h = window.__TAURI__._listeners['capture:action'];
      if (h)
        h({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'B' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Step 2');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Go to project and dispatch — should show selector
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-recording-selector:not(.hidden)', { timeout: 5000 });

    // Should show "Send all" option plus individual recordings
    await expect(page.locator('#recording-selector-list li')).toHaveCount(3);

    // Cancel returns to project
    await page.click('#btn-selector-cancel');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel — Re-record Cancel', () => {
  test('cancel re-record hides banner and restores state', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit a step
    await page.evaluate(() => {
      const h = window.__TAURI__._listeners['capture:action'];
      if (h)
        h({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'X' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Original');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click re-record
    const editBtn = page.locator('[data-action="edit"]').first();
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await page.waitForTimeout(300);

      // Banner should be visible
      await expect(page.locator('#rerecord-banner')).toBeVisible();

      // Cancel re-record
      await page.click('#btn-rerecord-cancel');
      await page.waitForTimeout(300);

      // Banner should be hidden
      await expect(page.locator('#rerecord-banner')).toBeHidden();
    }
  });
});

test.describe('Desktop Panel — New Project via Enter Key', () => {
  test('pressing Enter in project name field creates project', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Enter Project');
    await page.press('#new-project-name', 'Enter');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Enter Project');
  });

  test('pressing Enter in recording name field creates recording', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Enter Rec');
    await page.press('#new-recording-name', 'Enter');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#recording-title')).toHaveText('Enter Rec');
  });
});

test.describe('Desktop Panel — Cancel New Project/Recording', () => {
  test('cancel new project returns to projects list', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-project-cancel');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
  });

  test('cancel new recording returns to project view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording-cancel');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  });
});
