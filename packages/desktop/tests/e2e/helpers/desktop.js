/**
 * The desktop suite's fixture: the built app, its panel as a Playwright page,
 * and real keyboard input for other windows.
 *
 * The app is the release build (`cargo build --release --features
 * tauri/custom-protocol`, the frontend from `scripts/build-desktop-dist.js`),
 * or the executable `DOCENT_DESKTOP_EXE` names. It starts with WebView2's
 * DevTools port open, so the panel is driven as a page through its own
 * handlers and the real backend, the way the extension suite drives its side
 * panel. Each test starts the app on fresh data: its data and WebView folders
 * are removed first.
 */

import { test as base, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const IDENTIFIER = 'com.docent.desktop';
const DEVTOOLS_PORT = 9333;

export const APP_EXE =
  process.env.DOCENT_DESKTOP_EXE ??
  resolve(here, '../../../src-tauri/target/release/docent-desktop.exe');
export const APP_PROCESS = 'docent-desktop';

const POWERSHELL = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

/** Removes the app's data and WebView folders, so a run starts on no state. */
function clearAppData() {
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    if (root) rmSync(join(root, IDENTIFIER), { recursive: true, force: true });
  }
}

async function waitForDevTools(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the app's DevTools port did not answer within ${timeoutMs} ms (${last})`);
}

/**
 * The panel's page. The DevTools port can answer before the WebView has
 * created the page, so this waits for it.
 */
async function waitForPanel(browser, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pages = [];
  while (Date.now() < deadline) {
    pages = browser.contexts().flatMap((c) => c.pages());
    const panel = pages.find((p) => !p.url().startsWith('devtools:') && p.url() !== 'about:blank');
    if (panel) {
      await panel.waitForLoadState('domcontentloaded');
      return panel;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `no panel page within ${timeoutMs} ms among [${pages.map((p) => p.url()).join(', ')}]`,
  );
}

/** Ends a process and its children (the WebView2 processes). */
function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

/** Starts the built app on fresh data and returns its panel as a page. */
export async function launchApp() {
  if (!existsSync(APP_EXE)) throw new Error(`no app build at ${APP_EXE}`);
  clearAppData();
  const child = spawn(APP_EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEVTOOLS_PORT}`,
    },
    stdio: 'ignore',
  });
  try {
    await waitForDevTools(child, 60_000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEVTOOLS_PORT}`);
    const panel = await waitForPanel(browser, 30_000);
    return {
      panel,
      async close() {
        await browser.close().catch(() => {});
        killTree(child.pid);
      },
    };
  } catch (e) {
    killTree(child.pid);
    throw e;
  }
}

/**
 * Brings a process's window to the foreground (helpers/front.ps1). With
 * `dialog`, the process's open dialog window. The Alt press it needs is input:
 * call it before a recording starts.
 */
export function bringToFront(processName, { dialog = false, timeoutMs = 15_000 } = {}) {
  const args = [
    ...POWERSHELL,
    join(here, 'front.ps1'),
    '-Process',
    processName,
    '-TimeoutMs',
    String(timeoutMs),
  ];
  if (dialog) args.push('-Class', '#32770');
  const r = spawnSync('powershell', args, { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`front.ps1 ${processName}: rc ${r.status}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Sends real keyboard input with the driver (driver/drive.ps1, steps as its
 * README describes). Throws with the driver's log when it stops early.
 */
export function typeKeys(steps, { gapMs = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'docent-keys-'));
  const stepsFile = join(dir, 'steps.json');
  const log = join(dir, 'drive.log');
  writeFileSync(stepsFile, JSON.stringify(steps));
  const r = spawnSync(
    'powershell',
    [
      ...POWERSHELL,
      join(here, '../driver/drive.ps1'),
      '-Steps',
      stepsFile,
      '-Log',
      log,
      '-GapMs',
      String(gapMs),
    ],
    { encoding: 'utf8' },
  );
  const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0)
    throw new Error(`drive.ps1: rc ${r.status}: ${r.stdout}${r.stderr}\n${logText}`);
  return logText;
}

/** Waits until a file exists and returns its text. */
export async function readWhenWritten(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.length > 0) return text;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${path} was not written within ${timeoutMs} ms`);
}

/**
 * What was on the screen when a test failed: the windows (printed, so the job
 * log has them) and a screenshot (attached to the test's results). A spec
 * registers it with `test.afterEach`, which runs before the test's fixtures
 * end the app or Notepad.
 */
export function reportScreenOnFailure(_fixtures, testInfo) {
  if (testInfo.status === testInfo.expectedStatus) return;
  const png = testInfo.outputPath('screen.png');
  const r = spawnSync('powershell', [...POWERSHELL, join(here, 'screen.ps1'), '-Png', png], {
    encoding: 'utf8',
  });
  console.log(`[screen] ${testInfo.title}\n${r.stdout}${r.stderr}`);
  if (existsSync(png))
    testInfo.attachments.push({ name: 'screen', path: png, contentType: 'image/png' });
}

/** The suite's test: `app` is the built app, started fresh for the test. */
export const test = base.extend({
  // Notepad, started for the test and ended after it (after the hooks, so a
  // failed test's screen still shows it).
  // eslint-disable-next-line no-empty-pattern
  notepad: async ({}, use) => {
    const child = spawn('notepad.exe', [], { stdio: 'ignore' });
    try {
      await use(child);
    } finally {
      killTree(child.pid);
    }
  },
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    const app = await launchApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});

export { expect } from '@playwright/test';
