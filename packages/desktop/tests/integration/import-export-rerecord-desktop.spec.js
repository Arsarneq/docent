/**
 * Desktop E2E Tests — Import, Export, Re-record, and Drag Reorder
 *
 * Covers the desktop side of issue #30:
 * - Import: invoke('import_file') returns JSON → project appears in list
 * - Export: invoke('export_file') called with valid JSON
 * - Re-record: edit step → new actions → commit → narration updated
 * - Drag reorder: move step → verify step_number changes persist
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
  let _importResult = null;
  let _lastExport = null;

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
          case 'export_file':
            _lastExport = { data: args.data, defaultName: args.defaultName };
            return;
          case 'import_file':
            return _importResult;
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
    // Test helpers
    _setImportResult: (json) => { _importResult = json; },
    _getLastExport: () => _lastExport,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function navigateAndWait(page) {
  await page.goto(`http://127.0.0.1:${serverPort}/`);
  await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
}

async function createProjectWithStep(page) {
  await page.click('#btn-new-project');
  await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-project-name', 'Export Test');
  await page.click('#btn-new-project-create');
  await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
  await page.click('#btn-new-recording');
  await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
  await page.fill('#new-recording-name', 'Flow A');
  await page.click('#btn-new-recording-create');
  await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

  // Simulate a capture event and commit
  await page.evaluate(() => {
    const handler = window.__TAURI__._listeners['capture:action'];
    if (handler) {
      handler({
        payload: {
          type: 'click',
          timestamp: Date.now(),
          capture_mode: 'accessibility',
          context_id: 1,
          element: { text: 'Login', tag: 'Button', selector: '#btn' },
        },
      });
    }
  });
  await page.waitForTimeout(300);
  await page.fill('#narration-input', 'Click the login button');
  await page.click('#btn-commit-step');
  await page.waitForTimeout(500);
}

// ─── Import Flow ──────────────────────────────────────────────────────────────

test.describe('Desktop Import Flow', () => {
  test('importing via native dialog adds project to list', async ({ page }) => {
    await navigateAndWait(page);

    // Set up the mock to return a valid import JSON
    const importData = {
      docent_format: { platform: 'desktop-windows', schema_version: '1.0.0' },
      project: {
        project_id: '019e0000-0000-7000-8000-000000000001',
        name: 'Imported Project',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      recordings: [
        {
          recording_id: '019e0000-0000-7000-8000-000000000002',
          name: 'Imported Recording',
          created_at: '2026-01-01T00:00:00.000Z',
          steps: [
            {
              uuid: '019e0000-0000-7000-8000-000000000003',
              logical_id: '019e0000-0000-7000-8000-000000000004',
              step_number: 1,
              created_at: '2026-01-01T00:00:00.000Z',
              narration: 'Imported step',
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
                    text: 'OK',
                    selector: 'OK',
                  },
                },
              ],
              deleted: false,
            },
          ],
        },
      ],
    };

    await page.evaluate((data) => {
      window.__TAURI__._setImportResult(JSON.stringify(data));
    }, importData);

    // Click import
    await page.click('#btn-import-project');
    await page.waitForTimeout(500);

    // Project should appear in the list
    await expect(page.locator('.card-item')).toHaveCount(1);
    await expect(page.locator('.card-item-name')).toContainText('Imported Project');
  });
});

// ─── Export Flow ──────────────────────────────────────────────────────────────

test.describe('Desktop Export Flow', () => {
  test('export calls invoke with valid JSON', async ({ page }) => {
    await navigateAndWait(page);
    await createProjectWithStep(page);

    // Go to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Click export
    await page.click('#btn-export-project');
    await page.waitForTimeout(500);

    // Check what was exported via the mock
    const lastExport = await page.evaluate(() => window.__TAURI__._getLastExport());

    expect(lastExport).not.toBeNull();
    expect(lastExport.defaultName).toMatch(/\.docent\.json$/);

    const exported = JSON.parse(lastExport.data);
    expect(exported.project).toBeDefined();
    expect(exported.project.name).toBe('Export Test');
    expect(exported.recordings).toHaveLength(1);
    expect(exported.recordings[0].name).toBe('Flow A');
    expect(exported.recordings[0].steps).toHaveLength(1);
    expect(exported.recordings[0].steps[0].narration).toBe('Click the login button');
    expect(exported.recordings[0].steps[0].actions).toHaveLength(1);
  });
});

// ─── Re-record Flow ───────────────────────────────────────────────────────────

test.describe('Desktop Re-record Flow', () => {
  test('edit step → new actions → commit → narration updated', async ({ page }) => {
    await navigateAndWait(page);
    await createProjectWithStep(page);

    // Verify initial step
    await expect(page.locator('.step-narration')).toContainText('Click the login button');

    // Click edit (re-record) on the step
    await page.locator('[data-action="edit"]').first().click();
    await page.waitForTimeout(500);

    // Should show re-record banner
    await expect(page.locator('#rerecord-banner')).toBeVisible();

    // Simulate new capture event for the re-record
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'type',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { selector: '#email', tag: 'Input' },
            value: 'new@test.com',
          },
        });
      }
    });
    await page.waitForTimeout(300);

    // Update narration and commit
    await page.fill('#narration-input', 'Updated: type email address');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Re-record banner should be hidden
    await expect(page.locator('#rerecord-banner')).toBeHidden();

    // Step narration should be updated
    await expect(page.locator('.step-narration')).toContainText('Updated: type email address');

    // Still only 1 step (re-record replaces, doesn't add)
    await expect(page.locator('.step-item')).toHaveCount(1);
  });
});

// ─── Drag Reorder Flow ────────────────────────────────────────────────────────

test.describe('Desktop Drag Reorder Flow', () => {
  test('drag step to new position → order persists after navigation', async ({ page }) => {
    await navigateAndWait(page);

    // Create project with recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Reorder Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Commit 3 steps
    for (const label of ['First', 'Second', 'Third']) {
      await page.evaluate((stepLabel) => {
        const handler = window.__TAURI__._listeners['capture:action'];
        if (handler) {
          handler({
            payload: {
              type: 'click',
              timestamp: Date.now(),
              capture_mode: 'accessibility',
              context_id: 1,
              element: { text: stepLabel, tag: 'Button' },
            },
          });
        }
      }, label);
      await page.waitForTimeout(300);
      await page.fill('#narration-input', label);
      await page.click('#btn-commit-step');
      await page.waitForTimeout(500);
    }

    // Verify initial order
    const steps = page.locator('.step-narration');
    await expect(steps.nth(0)).toContainText('First');
    await expect(steps.nth(1)).toContainText('Second');
    await expect(steps.nth(2)).toContainText('Third');

    // Drag the third step to the first position
    const thirdStep = page.locator('.step-item').nth(2);
    const firstStep = page.locator('.step-item').nth(0);
    await thirdStep.dragTo(firstStep);
    await page.waitForTimeout(500);

    // Verify new order after drag
    await expect(steps.nth(0)).toContainText('Third');
    await expect(steps.nth(1)).toContainText('First');
    await expect(steps.nth(2)).toContainText('Second');

    // Navigate away and back to verify persistence
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Order should persist
    const stepsAfter = page.locator('.step-narration');
    await expect(stepsAfter.nth(0)).toContainText('Third');
    await expect(stepsAfter.nth(1)).toContainText('First');
    await expect(stepsAfter.nth(2)).toContainText('Second');
  });
});
