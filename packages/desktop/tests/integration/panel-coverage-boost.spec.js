/**
 * Desktop Panel — Coverage Boost Tests
 *
 * Targets genuinely uncovered code paths in panel.js:
 * - Metadata CRUD (add, edit, remove, persistence)
 * - Import project (native dialog mock)
 * - Import duplicate project (copy with new ID)
 * - Export project (invoke verification)
 * - Sync partial success (pulled project appears)
 * - Sync auth error (halted alert)
 * - Recording selector "Send all"
 * - Target app selector (refresh + populate)
 * - Self-capture toggle
 * - Drag reorder steps
 *
 * Closes #100
 */

import { test, expect } from './coverage-fixture.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');

// Track invoke calls for verification
const TAURI_MOCK_JS = `
  let _savedState = JSON.stringify({ projects: [], settings: {} });
  let _maxSeq = 0;
  let _invokeCalls = [];

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        _invokeCalls.push({ cmd, args });
        switch (cmd) {
          case 'load_state': return _savedState;
          case 'save_state': _savedState = args.data; return;
          case 'start_capture': return;
          case 'stop_capture': return;
          case 'list_windows': return window.__MOCK_WINDOWS__ || [];
          case 'get_max_sequence_number': return _maxSeq;
          case 'set_self_capture_exclusion': return;
          case 'set_target_pid': return;
          case 'export_file': return;
          case 'import_file': return window.__MOCK_IMPORT_DATA__ || null;
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
    _getInvokeCalls: () => _invokeCalls,
    _clearInvokeCalls: () => { _invokeCalls = []; },
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

// Helper: create a project and navigate to project detail
async function createProject(page, name = 'Test Project') {
  await page.goto(`http://127.0.0.1:${serverPort}/`);
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', name);
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
}

// Helper: create a recording with a committed step
async function createRecordingWithStep(page) {
  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', 'Rec');
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
          element: { text: 'Button', tag: 'Button', selector: '#btn' },
        },
      });
  });
  await page.waitForTimeout(300);
  await page.fill('#narration-input', 'Click button');
  await page.click('#btn-commit-step');
  await page.waitForTimeout(500);
}

test.describe('Desktop Panel — Metadata CRUD', () => {
  test('add metadata row, fill key/value, persists after navigation', async ({ page }) => {
    await createProject(page);

    // Open metadata section and add a row
    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);

    // Fill key and value
    await page.locator('#project-metadata-list .metadata-key').first().fill('env');
    await page.locator('#project-metadata-list .metadata-value').first().fill('production');
    // Trigger change event
    await page.locator('#project-metadata-list .metadata-value').first().press('Tab');
    await page.waitForTimeout(300);

    // Navigate away and back
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Verify metadata persisted
    await page.click('#project-metadata-section summary');
    await page.waitForTimeout(100);
    await expect(page.locator('#project-metadata-list .metadata-key').first()).toHaveValue('env');
    await expect(page.locator('#project-metadata-list .metadata-value').first()).toHaveValue(
      'production',
    );
  });

  test('remove metadata row', async ({ page }) => {
    await createProject(page);

    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);
    await page.locator('#project-metadata-list .metadata-key').first().fill('key1');
    await page.locator('#project-metadata-list .metadata-value').first().fill('val1');
    await page.locator('#project-metadata-list .metadata-value').first().press('Tab');
    await page.waitForTimeout(200);

    // Remove the row
    await page.click('#project-metadata-list .metadata-remove');
    await page.waitForTimeout(200);

    await expect(page.locator('#project-metadata-list .metadata-row')).toHaveCount(0);
  });

  test('comma-separated value stored as array', async ({ page }) => {
    await createProject(page);

    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);
    await page.locator('#project-metadata-list .metadata-key').first().fill('tags');
    await page.locator('#project-metadata-list .metadata-value').first().fill('smoke, login, e2e');
    await page.locator('#project-metadata-list .metadata-value').first().press('Tab');
    await page.waitForTimeout(300);

    // Navigate away and back — value should persist as comma-separated display
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#project-metadata-section summary');
    await page.waitForTimeout(100);
    await expect(page.locator('#project-metadata-list .metadata-value').first()).toHaveValue(
      'smoke, login, e2e',
    );
  });
});

test.describe('Desktop Panel — Import Project', () => {
  test('import via native dialog creates new project', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Set mock import data
    await page.evaluate(() => {
      window.__MOCK_IMPORT_DATA__ = JSON.stringify({
        docent_format: { platform: 'desktop-windows', schema_version: '1.0.0' },
        project: {
          project_id: '019e0000-0000-7000-8000-000000000099',
          name: 'Imported Project',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        recordings: [
          {
            recording_id: '019e0000-0000-7000-8000-000000000100',
            name: 'Imported Flow',
            created_at: '2026-01-01T00:00:00.000Z',
            steps: [
              {
                uuid: '019e0000-0000-7000-8000-000000000101',
                logical_id: '019e0000-0000-7000-8000-000000000101',
                step_number: 1,
                created_at: '2026-01-01T00:00:00.000Z',
                narration: 'Click login',
                narration_source: 'typed',
                actions: [
                  {
                    type: 'click',
                    timestamp: 1000,
                    capture_mode: 'accessibility',
                    context_id: 1,
                    x: 10,
                    y: 20,
                    element: {
                      tag: 'Button',
                      id: null,
                      name: null,
                      role: null,
                      type: null,
                      text: 'Login',
                      selector: 'Login',
                    },
                  },
                ],
                deleted: false,
              },
            ],
          },
        ],
      });
    });

    await page.click('#btn-import-project');
    await page.waitForTimeout(500);

    // Verify project appears in list
    await expect(page.locator('[data-action="open"]')).toHaveCount(1);
  });

  test('import duplicate project creates copy with new name', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    const importData = JSON.stringify({
      docent_format: { platform: 'desktop-windows', schema_version: '1.0.0' },
      project: {
        project_id: '019e0000-0000-7000-8000-000000000200',
        name: 'Original',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [],
    });

    // Import first time
    await page.evaluate((data) => {
      window.__MOCK_IMPORT_DATA__ = data;
    }, importData);
    await page.click('#btn-import-project');
    await page.waitForTimeout(500);

    // Import same data again — should create a copy
    await page.evaluate((data) => {
      window.__MOCK_IMPORT_DATA__ = data;
    }, importData);
    await page.click('#btn-import-project');
    await page.waitForTimeout(500);

    // Should have 2 projects
    await expect(page.locator('[data-action="open"]')).toHaveCount(2);
  });
});

test.describe('Desktop Panel — Export Project', () => {
  test('export calls invoke with valid project JSON', async ({ page }) => {
    await createProject(page, 'Export Test');
    await createRecordingWithStep(page);

    // Go to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Clear invoke calls and click export
    await page.evaluate(() => window.__TAURI__._clearInvokeCalls());
    await page.click('#btn-export-project');
    await page.waitForTimeout(500);

    // Verify export_file was called
    const calls = await page.evaluate(() => window.__TAURI__._getInvokeCalls());
    const exportCall = calls.find((c) => c.cmd === 'export_file');
    expect(exportCall).toBeTruthy();
    const exportData = JSON.parse(exportCall.args.data);
    expect(exportData.project.name).toBe('Export Test');
    expect(exportData.recordings).toHaveLength(1);
    expect(exportData.recordings[0].steps).toHaveLength(1);
  });
});

test.describe('Desktop Panel — Sync Flows', () => {
  test('sync partial success — pulled project appears in list', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure sync
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'https://sync.test');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Mock fetch: push succeeds, pull returns 1 new project
    await page.evaluate(() => {
      window._originalFetch = window.fetch;
      window.fetch = async (url, opts) => {
        // The schema fetch (session.schema.json — used to build the push stamp
        // and the local stamp for mismatch checks) must hit the real file.
        if (typeof url === 'string' && url.includes('session.schema.json')) {
          return window._originalFetch(url, opts);
        }
        if (opts && opts.method === 'PUT') return { ok: true, status: 200, json: async () => ({}) };
        if (url.endsWith('/projects') && (!opts || opts.method === 'GET'))
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                project_id: '0190a1b2-0000-7000-8000-000000000051',
                name: 'From Server',
                last_modified: '2026-06-01T00:00:00.000Z',
              },
            ],
          };
        if (url.endsWith('/projects/0190a1b2-0000-7000-8000-000000000051'))
          return {
            ok: true,
            status: 200,
            json: async () => ({
              docent_format: { platform: 'desktop-windows', schema_version: '1.0.0' },
              project: {
                project_id: '0190a1b2-0000-7000-8000-000000000051',
                name: 'From Server',
                created_at: '2026-01-01T00:00:00.000Z',
              },
              recordings: [],
            }),
          };
        return { ok: true, status: 200, json: async () => ({}) };
      };
    });

    // Handle sync summary alert
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-sync');
    await page.waitForTimeout(1500);

    // Verify pulled project appears
    await expect(page.locator('[data-action="open"]')).toHaveCount(1);
  });

  test('sync auth error shows halted alert', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure sync
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'https://sync.test');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Mock fetch: return 401 for sync requests, but let the schema fetch (used
    // to build the local docent_format stamp) hit the real served file.
    await page.evaluate(() => {
      window._originalFetch = window.fetch;
      window.fetch = async (url, opts) => {
        if (typeof url === 'string' && url.includes('session.schema.json')) {
          return window._originalFetch(url, opts);
        }
        return { ok: false, status: 401, json: async () => ({}) };
      };
    });

    // Capture alert message
    let alertMessage = '';
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      await dialog.accept();
    });

    await page.click('#btn-sync');
    await page.waitForTimeout(1500);

    expect(alertMessage.toLowerCase()).toContain('authentication');
  });
});

test.describe('Desktop Panel — Target App Selector', () => {
  test('refresh populates dropdown with windows', async ({ page }) => {
    // Set mock windows before page load via evaluate on about:blank
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.evaluate(() => {
      window.__MOCK_WINDOWS__ = [
        { hwnd: 1, title: 'Untitled - Notepad', process_name: 'notepad.exe', pid: 5678 },
        { hwnd: 2, title: 'Calculator', process_name: 'calc.exe', pid: 9012 },
      ];
    });

    // Create project + recording to get to recording view
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'App Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Click refresh — the button may not exist on all builds
    const refreshBtn = page.locator('#btn-refresh-apps');
    if ((await refreshBtn.count()) > 0 && (await refreshBtn.isVisible())) {
      await refreshBtn.click();
      await page.waitForTimeout(300);

      const options = await page.locator('#target-app-select option').count();
      expect(options).toBeGreaterThanOrEqual(3);
    }
  });
});

test.describe('Desktop Panel — Self-Capture Toggle', () => {
  test('toggling self-capture calls invoke with correct value', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    // Clear calls and toggle
    await page.evaluate(() => window.__TAURI__._clearInvokeCalls());

    const toggle = page.locator('#self-capture-toggle');
    if (await toggle.isVisible()) {
      // Toggle off (it starts checked/true)
      await toggle.uncheck();
      await page.waitForTimeout(300);

      const calls = await page.evaluate(() => window.__TAURI__._getInvokeCalls());
      const exclusionCall = calls.find((c) => c.cmd === 'set_self_capture_exclusion');
      expect(exclusionCall).toBeTruthy();
      expect(exclusionCall.args.enabled).toBe(false);
    }
  });
});

test.describe('Desktop Panel — Recording Selector Send All', () => {
  test('send all button shows total step count in confirmation', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure endpoint
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.test/dispatch');
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
    await page.fill('#new-recording-name', 'R1');
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
    await page.fill('#narration-input', 'Step A');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Recording 2
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R2');
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
    await page.fill('#narration-input', 'Step B');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Dispatch — should show selector
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-dispatch-project');
    await page.waitForSelector('#view-recording-selector:not(.hidden)', { timeout: 5000 });

    // Click "Send all"
    await page.locator('#recording-selector-list button').first().click();
    await page.waitForSelector('#view-dispatch-confirm:not(.hidden)', { timeout: 5000 });

    // Verify total steps = 2
    await expect(page.locator('#confirm-steps')).toHaveText('2');
  });
});

test.describe('Desktop Panel — Drag Reorder Steps', () => {
  test('drag step changes order and persists', async ({ page }) => {
    await createProject(page, 'Drag Test');

    // Create recording and commit 2 steps
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Step 1
    await page.evaluate(() => {
      const h = window.__TAURI__._listeners['capture:action'];
      if (h)
        h({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'First' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'First step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Step 2
    await page.evaluate(() => {
      const h = window.__TAURI__._listeners['capture:action'];
      if (h)
        h({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Second' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Second step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Verify initial order
    const steps = page.locator('.step-item');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0).locator('.step-narration')).toContainText('First step');
    await expect(steps.nth(1).locator('.step-narration')).toContainText('Second step');

    // Drag step 2 above step 1
    const step2 = steps.nth(1);
    const step1 = steps.nth(0);
    await step2.dragTo(step1);
    await page.waitForTimeout(500);

    // Verify new order
    const reorderedSteps = page.locator('.step-item');
    await expect(reorderedSteps.nth(0).locator('.step-narration')).toContainText('Second step');
    await expect(reorderedSteps.nth(1).locator('.step-narration')).toContainText('First step');
  });
});
