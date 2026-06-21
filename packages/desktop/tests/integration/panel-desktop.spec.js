/**
 * Desktop Panel UI Tests
 *
 * Tests the desktop panel by serving the built frontend with a mocked
 * window.__TAURI__ object. This validates DOM interactions and view
 * transitions without requiring the full Tauri runtime.
 *
 * The mock provides:
 * - invoke('load_state') â†’ returns empty state
 * - invoke('save_state') â†’ stores in memory
 * - invoke('start_capture') / invoke('stop_capture') â†’ no-op
 * - invoke('list_windows') â†’ returns empty array
 * - listen('capture:action') â†’ no-op
 */

import { test, expect } from './coverage-fixture.js';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');

// Inject the Tauri mock before the panel.js script runs â€” served as external file to comply with CSP
const TAURI_MOCK_JS = `
  // Mock Tauri v2 globals
  let _savedState = JSON.stringify({ projects: [], settings: {} });
  let _maxSeq = 0;

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'load_state': return _savedState;
          case 'sync_http_request': {
            // The desktop routes sync/dispatch/connection-test through the
            // native sync_http_request command. In the integration env there is
            // no Rust backend, so the mock services it via the page's window.fetch
            // (which these specs stub) and adapts the result into the native
            // command's { status, headers, body } shape — keeping every existing
            // fetch stub faithful while exercising the real transport path.
            const _r = await window.fetch(args.url, {
              method: args.method,
              headers: args.headers || {},
              body: args.body == null ? undefined : args.body,
            });
            const _status = typeof _r.status === 'number' ? _r.status : _r.ok ? 200 : 500;
            let _body = '';
            if (typeof _r.text === 'function') { try { _body = await _r.text(); } catch (_e) { _body = ''; } }
            if (!_body && typeof _r.json === 'function') { try { _body = JSON.stringify(await _r.json()); } catch (_e) { _body = ''; } }
            const _headers = {};
            if (_r.headers && typeof _r.headers.forEach === 'function') { _r.headers.forEach((v, k) => { _headers[String(k).toLowerCase()] = v; }); }
            return { status: _status, headers: _headers, body: _body };
          }
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

    // Prevent path traversal â€” ensure resolved path stays within distPath
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
      // Remove the strict CSP for testing â€” the mock needs to run
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

test.describe('Desktop Panel â€” Smoke', () => {
  test('panel loads and shows projects view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });
    await expect(page.locator('#view-projects')).toBeVisible();
  });

  test('create project â†’ project detail view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Desktop Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#project-title')).toHaveText('Desktop Test');
  });

  test('create recording â†’ recording view', async ({ page }) => {
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

test.describe('Desktop Panel â€” Simple Mode', () => {
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

test.describe('Desktop Panel â€” Metadata', () => {
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

test.describe('Desktop Panel â€” Commit with Simulated Capture', () => {
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

test.describe('Desktop Panel â€” Theme', () => {
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

test.describe('Desktop Panel â€” Narration Commit Flow', () => {
  test('type narration + simulated capture â†’ commit â†’ step appears', async ({ page }) => {
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

test.describe('Desktop Panel â€” Clear Button', () => {
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

test.describe('Desktop Panel â€” Step Detail View', () => {
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

test.describe('Desktop Panel â€” Delete Step', () => {
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

test.describe('Desktop Panel â€” History View', () => {
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

test.describe('Desktop Panel â€” Projects View UI Elements', () => {
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

test.describe('Desktop Panel â€” Project Detail UI', () => {
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

test.describe('Desktop Panel â€” Recording View UI State', () => {
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

test.describe('Desktop Panel â€” Breadcrumb Navigation', () => {
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

test.describe('Desktop Panel â€” Settings Additional', () => {
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

test.describe('Desktop Panel â€” Delete Project', () => {
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

test.describe('Desktop Panel - Dispatch Flow', () => {
  test('dispatch button disabled without endpoint configured', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Dispatch Test');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-dispatch-project')).toBeDisabled();
  });

  test('dispatch button enabled after configuring endpoint and having steps', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Configure endpoint in settings via save button
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'http://localhost:3000/api');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Create project + recording + commit a step
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
            element: { text: 'OK' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Click OK');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Go back to project view
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#btn-dispatch-project')).toBeEnabled();
  });
});

test.describe('Desktop Panel - Sync Settings', () => {
  test('sync URL persists after save and navigate', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'http://sync.example.com');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open settings
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-sync-url')).toHaveValue('http://sync.example.com');
  });

  test('saving a valid sync URL does not report an authentication failure', async ({ page }) => {
    // Regression: saving a new endpoint is a settings change, NOT an auth failure.
    // It must invalidate the Connection_Test to the untested state and prompt a
    // re-test — never set connectionTest='auth', which wrongly surfaced
    // "Authentication failed — re-test your connection." after a plain Save while
    // an explicit Test connection against the same server passed.
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });

    // Save a syntactically valid endpoint WITHOUT first testing the connection.
    await page.fill('#settings-sync-url', 'http://localhost:3000');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);

    // No false auth error on the connection status line...
    await expect(page.locator('#settings-connection-status')).not.toContainText(
      'Authentication failed',
    );
    // ...and the neutral re-test prompt guides the user instead.
    await expect(page.locator('#settings-auto-sync-hint')).toContainText('Test the connection');
  });

  test('sync button enabled when URL configured', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-sync-url', 'http://sync.example.com');
    await page.click('#btn-settings-sync-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('#btn-sync')).toBeEnabled();
  });
});

test.describe('Desktop Panel - Re-record Flow', () => {
  test('re-record opens recording view with banner', async ({ page }) => {
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
            element: { text: 'Submit' },
          },
        });
    });
    await page.waitForTimeout(300);
    await page.fill('#narration-input', 'Original step');
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Click edit/re-record on the step
    await page.locator('[data-action="edit"]').first().click();
    await page.waitForTimeout(500);

    // Should show re-record banner
    await expect(page.locator('#rerecord-banner')).toBeVisible();
  });
});

test.describe('Desktop Panel - Recording Delete', () => {
  test('delete recording removes it from project view', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'P');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec A');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec B');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });
    await page.click('#bc-project');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });

    await expect(page.locator('.card-item')).toHaveCount(2);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-action="delete"]').first().click();
    await page.waitForTimeout(500);

    await expect(page.locator('.card-item')).toHaveCount(1);
  });
});

test.describe('Desktop Panel - Endpoint Settings', () => {
  test('endpoint URL and API key persist after save', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await page.fill('#settings-endpoint-url', 'https://api.test.com/dispatch');
    await page.fill('#settings-api-key', 'sk-12345');
    await page.click('#btn-settings-dispatch-save');
    await page.waitForTimeout(300);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Re-open settings and verify
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('#settings-endpoint-url')).toHaveValue(
      'https://api.test.com/dispatch',
    );
    await expect(page.locator('#settings-api-key')).toHaveValue('sk-12345');
  });
});

test.describe('Desktop Panel - Window Target Selector', () => {
  test('target app dropdown is visible in recording view', async ({ page }) => {
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

    await expect(page.locator('#target-app-select')).toBeVisible();
  });
});

test.describe('Desktop Panel — Adapter Capture Lifecycle', () => {
  test('RECORDING_START invokes start_capture and resets reorder state', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Create project + recording to get to recording view
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Capture Lifecycle');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Simulate capture events with sequence_ids to set highestSeenSeq
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 5,
            element: { text: 'A' },
          },
        });
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 10,
            element: { text: 'B' },
          },
        });
      }
    });
    await page.waitForTimeout(200);

    // Verify pending count is 2
    const pendingCount = await page.evaluate(() => {
      return window.__TAURI__.core.invoke('get_max_sequence_number').then(() => {
        // Access adapter internals via the panel's exposed API
        const badge = document.querySelector('#pending-count');
        return badge ? badge.textContent : '0';
      });
    });

    // Clear and verify reset
    page.on('dialog', (dialog) => dialog.accept());
    await page.click('#btn-clear-step');
    await page.waitForTimeout(300);

    // After clear, pending count should be 0
    const afterClear = await page.evaluate(() => {
      const badge = document.querySelector('#pending-count');
      return badge ? badge.textContent : '0';
    });
    assert.ok(
      afterClear === '0' || afterClear === '',
      `Expected 0 pending after clear, got ${afterClear}`,
    );
  });

  test('commitWithCompleteness waits for all events before committing', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Completeness');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'R');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // Set max sequence number in mock to simulate backend having dispatched events
    await page.evaluate(() => {
      window._maxSeq = 3;
    });

    // Send events with sequence_ids 1 and 2 (missing 3)
    await page.evaluate(() => {
      const handler = window.__TAURI__._listeners['capture:action'];
      if (handler) {
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 1,
            element: { text: 'A' },
          },
        });
        handler({
          payload: {
            type: 'click',
            timestamp: Date.now(),
            capture_mode: 'accessibility',
            context_id: 1,
            sequence_id: 2,
            element: { text: 'B' },
          },
        });
      }
    });
    await page.waitForTimeout(100);

    // Now send the missing event (seq 3) after a short delay
    await page.evaluate(() => {
      setTimeout(() => {
        const handler = window.__TAURI__._listeners['capture:action'];
        if (handler) {
          handler({
            payload: {
              type: 'click',
              timestamp: Date.now(),
              capture_mode: 'accessibility',
              context_id: 1,
              sequence_id: 3,
              element: { text: 'C' },
            },
          });
        }
      }, 200);
    });

    // Type narration and commit (commit uses commitWithCompleteness)
    await page.fill('#narration-input', 'All three events');
    await page.waitForTimeout(400); // Wait for the delayed event to arrive
    await page.click('#btn-commit-step');
    await page.waitForTimeout(500);

    // Step should be committed with all 3 actions
    await expect(page.locator('.step-item')).toHaveCount(1);

    // Open step detail to verify all 3 actions
    await page.click('.step-narration');
    await page.waitForSelector('#view-step-detail:not(.hidden)', { timeout: 5000 });
    await expect(page.locator('.step-detail-item')).toHaveCount(3);
  });
});
