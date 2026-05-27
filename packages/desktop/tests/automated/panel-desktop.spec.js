/**
 * Desktop Panel UI Tests
 *
 * Tests the desktop panel by serving the built frontend with a mocked
 * window.__TAURI__ object. This validates DOM interactions and view
 * transitions without requiring the full Tauri runtime.
 *
 * The mock provides:
 * - invoke('load_state') → returns empty state
 * - invoke('save_state') → stores in memory
 * - invoke('start_capture') / invoke('stop_capture') → no-op
 * - invoke('list_windows') → returns empty array
 * - listen('capture:action') → no-op
 */

import { test, expect } from '@playwright/test';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');

// Inject the Tauri mock before the panel.js script runs — served as external file to comply with CSP
const TAURI_MOCK_JS = `
  // Mock Tauri v2 globals
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
          case 'export_file': return;
          case 'import_file': return null;
          default: console.warn('[Mock] Unknown invoke:', cmd); return null;
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
  // Start a local server that serves the desktop dist with the Tauri mock injected
  server = http.createServer((req, res) => {
    // Serve the Tauri mock as a virtual file
    if (req.url === '/__tauri-mock.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(TAURI_MOCK_JS);
      return;
    }

    let filePath = path.resolve(distPath, req.url === '/' ? 'index.html' : req.url.slice(1));

    // Prevent path traversal — ensure resolved path stays within distPath
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

    // Inject the Tauri mock as an external script reference to comply with CSP
    // Also relax CSP for testing (allow the mock script from same origin)
    if (ext === '.html') {
      // Remove the strict CSP for testing — the mock needs to run
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

test.describe('Desktop Panel — Smoke', () => {
  test('panel loads and shows projects view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('create project → project detail view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Desktop Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Desktop Test');
  });

  test('create recording → recording view', async ({ page }) => {
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

    await expect(page.locator('#recording-title')).toHaveText('R');
  });
});

test.describe('Desktop Panel — Simple Mode', () => {
  test('switching to simple mode shows simple mode box', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Switch to simple mode in settings
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
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

    await expect(page.locator('#simple-mode-box')).toBeVisible();
    await expect(page.locator('#narration-mode-box')).toBeHidden();
  });
});

test.describe('Desktop Panel — Metadata', () => {
  test('project metadata section exists and add button works', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Meta');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-metadata-section')).toBeAttached();

    // Open and add a row
    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);

    await expect(page.locator('#project-metadata-list .metadata-row')).toHaveCount(1);
  });

  test('metadata persists after navigating away and back', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Persist Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Add metadata
    await page.click('#project-metadata-section summary');
    await page.click('#btn-add-project-metadata');
    await page.waitForTimeout(100);
    await page.locator('#project-metadata-list .metadata-key').first().fill('env');
    await page.locator('#project-metadata-list .metadata-value').first().fill('prod');
    await page.locator('#project-metadata-list .metadata-value').first().press('Tab');
    await page.waitForTimeout(300);

    // Navigate to projects list and back
    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open the project
    await page.click('[data-action="open"]');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    // Metadata should still be there
    await page.click('#project-metadata-section summary');
    await page.waitForTimeout(100);
    await expect(page.locator('#project-metadata-list .metadata-key').first()).toHaveValue('env');
    await expect(page.locator('#project-metadata-list .metadata-value').first()).toHaveValue(
      'prod',
    );
  });
});

test.describe('Desktop Panel — Commit with Simulated Capture', () => {
  test('simulated capture event enables commit in simple mode', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Switch to simple mode
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Capture Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Simulate a capture:action event via the Tauri mock
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Button', tag: 'Button' },
          },
        });
      }
    });
    await page.waitForTimeout(300);

    // Commit button should be enabled (pending action exists)
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();

    // Commit
    await page.click('#btn-commit-step-simple');
    await page.waitForTimeout(500);

    // Step should appear
    await expect(page.locator('.step-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel — Theme', () => {
  test('theme switch updates data-theme attribute', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    const darkLabel = page.locator('input[name="theme"][value="dark"]').locator('..');
    await darkLabel.scrollIntoViewIfNeeded();
    await darkLabel.click();
    await page.waitForTimeout(200);

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('Desktop Panel — Narration Commit Flow', () => {
  test('type narration + simulated capture → commit → step appears', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project + recording
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

    // Simulate a capture event
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Login' },
          },
        });
    });
    await page.waitForTimeout(300);

    // Type narration and commit
    await page.fill('#narration-input', 'Click the login button');
    await expect(page.locator('#btn-commit-step')).toBeEnabled();
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Step should appear
    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('.step-narration')).toContainText('Click the login button');
    await expect(page.locator('#step-count')).toHaveText('1');
  });

  test('commit button disabled without narration text', async ({ page }) => {
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

    // Simulate pending action but no narration
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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

    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('commit button disabled without pending actions', async ({ page }) => {
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

    // Type narration but no pending actions
    await page.fill('#narration-input', 'Some narration');
    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });

  test('narration input clears after commit', async ({ page }) => {
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

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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

    await page.fill('#narration-input', 'Step one');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('#narration-input')).toHaveValue('');
  });

  test('multiple steps accumulate in the step list', async ({ page }) => {
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

    // First step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Second step
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'type',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'B' },
            value: 'hello',
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Second');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(2);
    await expect(page.locator('#step-count')).toHaveText('2');
  });
});

test.describe('Desktop Panel — Clear Button', () => {
  test('clear resets pending actions and disables commit', async ({ page }) => {
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

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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
    await page.fill('#narration-input', 'Something');
    await expect(page.locator('#btn-commit-step')).toBeEnabled();

    // Accept confirm dialog
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-clear-step');
    await page.waitForTimeout(500);

    await expect(page.locator('#btn-commit-step')).toBeDisabled();
  });
});

test.describe('Desktop Panel — Step Detail View', () => {
  test('clicking step narration opens detail view', async ({ page }) => {
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
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            element: { text: 'Submit', selector: '#btn' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Click submit');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click step to open detail
    await page.click('.step-narration');
    await page.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.step-detail-item')).toHaveCount(1);
    await expect(page.locator('#step-detail-title')).toContainText('Click submit');

    // Back button
    await page.click('#btn-step-detail-back');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel — Delete Step', () => {
  test('delete removes step from list', async ({ page }) => {
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

    // Commit two steps
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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
    await page.fill('#narration-input', 'First');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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
    await page.fill('#narration-input', 'Second');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(2);

    // Delete first step
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.step-item')).toHaveCount(1);
    await expect(page.locator('#step-count')).toHaveText('1');
  });
});

test.describe('Desktop Panel — History View', () => {
  test('history button shows step versions', async ({ page }) => {
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
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler)
        handler({
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

    // Click history
    await page.locator('[data-action="history"]').first().click();
    await page.waitForSelector('#view-history:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.history-item')).toHaveCount(1);

    // Back
    await page.click('#btn-history-back');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
  });
});

test.describe('Desktop Panel — Projects View UI Elements', () => {
  test('file input is hidden', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#import-file-input')).toBeHidden();
  });

  test('sync button is visible and disabled without config', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#btn-sync')).toBeVisible();
    await expect(page.locator('#btn-sync')).toBeDisabled();
  });

  test('import button is visible', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#btn-import-project')).toBeVisible();
  });

  test('empty state shown when no projects', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});

test.describe('Desktop Panel — Project Detail UI', () => {
  test('export button is visible', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-export-project')).toBeVisible();
  });

  test('recording list shows created recording', async ({ page }) => {
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

    // Go back to project detail
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel — Recording View UI State', () => {
  test('pending actions section is hidden initially', async ({ page }) => {
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

    await expect(page.locator('#pending-actions-section')).toBeHidden();
  });

  test('recording badge shows Recording state after create', async ({ page }) => {
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

    await expect(page.locator('#recording-badge')).toContainText('Recording');
  });
});

test.describe('Desktop Panel — Breadcrumb Navigation', () => {
  test('breadcrumb navigates back to projects list', async ({ page }) => {
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

    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('breadcrumb project link navigates to project detail', async ({ page }) => {
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

    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-project')).toBeVisible();
  });
});

test.describe('Desktop Panel — Settings Additional', () => {
  test('settings back button returns to previous view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('sync URL input is visible in settings', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const syncInput = page.locator('#settings-sync-url');
    await syncInput.scrollIntoViewIfNeeded();
    await expect(syncInput).toBeVisible();
  });
});

test.describe('Desktop Panel — Delete Project', () => {
  test('delete removes project from list', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'To Delete');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#bc-projects');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.card-item')).toHaveCount(1);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.card-item')).toHaveCount(0);
    await expect(page.locator('#projects-empty')).toBeVisible();
  });
});
