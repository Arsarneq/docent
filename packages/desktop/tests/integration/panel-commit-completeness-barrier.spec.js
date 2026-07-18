/**
 * Desktop Panel — commit completeness-barrier regression
 *
 * Red-proof for the confirmed defect "panel commit sidesteps the completeness
 * barrier": on a normal step commit the desktop panel stopped capture BEFORE
 * running the flush barrier, so `commit_barrier` reported no active capture
 * (`barrier_id: 0`), the delivery sentinel never engaged, and step completeness
 * rested on `stop()`'s drain racing the unordered `capture:action` channel — the
 * exact race the sentinel design closes. This defect lived in the project's
 * working backlog, not a GitHub issue, so the regression uses the no-issue name
 * form (`regression_noissue_*`).
 *
 * The fix fuses the in-order flush barrier INTO `stop_capture` (drain-then-
 * deactivate, atomic in the Windows capture layer): `stop_capture` returns a
 * real `{ barrier_id, wedged_workers }` report and the commit waits for that
 * barrier's `barrier_complete` sentinel — no separate `commit_barrier` call.
 *
 * This spec drives the real frontend against a mocked Tauri backend that models
 * the fixed contract (`stop_capture` returns a real barrier id and does NOT
 * auto-emit the sentinel — the spec controls delivery) and records the invoke
 * order. It asserts, on a normal recording commit, that (1) the step does not
 * finalize until the stop-path sentinel arrives — the gate — (2) the commit runs
 * through `stop_capture` and NOT a separate `commit_barrier`, and (3) an action
 * drained after the commit click but before the sentinel is still captured into
 * the step. On the pre-fix tree the commit ignores the stop report, calls
 * `commit_barrier` (→ barrier_id 0), and finalizes immediately, so (1)–(3) fail.
 */

import { test, expect } from './coverage-fixture.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../../dist');

// The barrier id the fused stop path reports; the commit must wait for the
// matching `barrier_complete` sentinel on the capture:action stream.
const STOP_BARRIER_ID = 4242;

// Mock Tauri modelling the FIXED backend contract: `stop_capture` returns a real
// barrier report and does NOT auto-emit the sentinel (the spec fires it), while
// `commit_barrier` remains a no-op reporting no active capture. Every invoke is
// recorded into window.__invokeLog so the spec can assert the commit's command
// order.
const TAURI_MOCK_JS = `
  let _savedState = JSON.stringify({ projects: [], settings: {} });
  window.__invokeLog = [];

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        window.__invokeLog.push(cmd);
        switch (cmd) {
          case 'load_state': return _savedState;
          case 'save_state': _savedState = args.data; return;
          case 'start_capture': return;
          case 'stop_capture': return { barrier_id: ${STOP_BARRIER_ID}, wedged_workers: 0 };
          case 'list_windows': return [];
          case 'commit_barrier': return { barrier_id: 0, wedged_workers: 0 };
          case 'set_self_capture_exclusion': return;
          case 'export_file': return;
          case 'import_file': return null;
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

/** Fire one capture:action payload through the recorded backend listener. */
async function fireCaptureAction(page, payload) {
  await page.evaluate((p) => {
    const handler = window.__TAURI__._listeners['capture:action'];
    if (handler) handler({ payload: p });
  }, payload);
}

const clickAction = (text) => ({
  type: 'click',
  timestamp: Date.now(),
  capture_mode: 'accessibility',
  context_id: 1,
  element: { text, tag: 'Button' },
});

test.describe('Desktop Panel — commit completeness barrier', () => {
  test('regression_noissue_commit_engages_stop_path_flush_barrier', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${serverPort}/`);
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 10000 });

    // Simple mode so "Done this step" commits without a narration entry.
    await page.click('#btn-settings');
    await page.waitForSelector('#view-settings:not(.hidden)', { timeout: 5000 });
    const simpleLabel = page.locator('input[name="recording-mode"][value="simple"]').locator('..');
    await simpleLabel.scrollIntoViewIfNeeded();
    await simpleLabel.click();
    await page.waitForTimeout(200);
    await page.click('#btn-settings-back');
    await page.waitForSelector('#view-projects:not(.hidden)', { timeout: 5000 });

    // Project + recording → recording view (capture is active here).
    await page.click('#btn-new-project');
    await page.waitForSelector('#view-new-project:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-project-name', 'Barrier');
    await page.click('#btn-new-project-create');
    await page.waitForSelector('#view-project:not(.hidden)', { timeout: 5000 });
    await page.click('#btn-new-recording');
    await page.waitForSelector('#view-new-recording:not(.hidden)', { timeout: 5000 });
    await page.fill('#new-recording-name', 'Rec');
    await page.click('#btn-new-recording-create');
    await page.waitForSelector('#view-recording:not(.hidden)', { timeout: 5000 });

    // An action captured during the step.
    await fireCaptureAction(page, clickAction('First'));
    await page.waitForTimeout(200);
    await expect(page.locator('#btn-commit-step-simple')).toBeEnabled();

    // Snapshot only the commit's invoke order.
    await page.evaluate(() => {
      window.__invokeLog.length = 0;
    });

    // Commit. The sentinel has NOT been fired yet.
    await page.click('#btn-commit-step-simple');
    await page.waitForTimeout(400);

    // (1) GATE — the step must not finalize until the stop-path sentinel lands.
    // Pre-fix, the commit ignores the stop report and finalizes immediately.
    await expect(page.locator('.step-item')).toHaveCount(0);

    // (2) The commit ran through the stop path — `stop_capture` invoked, and the
    // flush is NOT a separate `commit_barrier` call (it is fused into stop).
    const midLog = await page.evaluate(() => window.__invokeLog.slice());
    expect(midLog).toContain('stop_capture');
    expect(midLog).not.toContain('commit_barrier');

    // A held action drains after the click but before the sentinel — it must
    // still land in the committed step (completeness).
    await fireCaptureAction(page, clickAction('Second'));

    // Deliver the barrier sentinel for the id the stop path reported.
    await fireCaptureAction(page, { type: 'barrier_complete', barrier_id: STOP_BARRIER_ID });

    // (3) The step now finalizes, carrying both actions.
    await expect(page.locator('.step-item')).toHaveCount(1);

    const committedActionCount = await page.evaluate(async () => {
      const raw = await window.__TAURI__.core.invoke('load_state');
      const state = JSON.parse(raw);
      let max = 0;
      for (const proj of state.projects ?? []) {
        for (const rec of proj.recordings ?? []) {
          for (const step of rec.steps ?? []) {
            if (Array.isArray(step.actions)) max = Math.max(max, step.actions.length);
          }
        }
      }
      return max;
    });
    expect(committedActionCount).toBe(2);
  });
});
