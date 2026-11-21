/**
 * The desktop suite's fixture: the built app, its panel as a Playwright page,
 * and real keyboard input for other windows.
 *
 * The app is the release build (`cargo build --release --features
 * tauri/custom-protocol`, the frontend from `scripts/build-desktop-dist.js`),
 * or the executable `DOCENT_DESKTOP_EXE` names. It starts with WebView2's
 * DevTools port open, so the panel is driven as a page through its own
 * handlers and the real backend, the way the extension suite drives its side
 * panel. The panel's buttons are clicked through that protocol, not with
 * operating-system input, so a click on the panel does not move the
 * foreground. Each test starts the app on a data folder of its own: `APPDATA`
 * points at a new temporary folder, where the app keeps its projects, so a
 * run never reads or removes the projects of a Docent installed on the
 * machine. The app's API keys are not kept there but in Windows Credential
 * Manager, per user, which this does not separate: run the suite as a user
 * with no Docent keys stored.
 */

import { test as base, chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DEVTOOLS_PORT = 9333;

export const APP_EXE =
  process.env.DOCENT_DESKTOP_EXE ??
  resolve(here, '../../../src-tauri/target/release/docent-desktop.exe');
/** The app's process name, as `Get-Process` and the driver's guard know it. */
export const APP_PROCESS = basename(APP_EXE, '.exe');

const POWERSHELL = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

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
  const appData = mkdtempSync(join(tmpdir(), 'docent-e2e-data-'));
  const child = spawn(APP_EXE, [], {
    env: {
      ...process.env,
      APPDATA: appData,
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
        rmSync(appData, { recursive: true, force: true, maxRetries: 5 });
      },
    };
  } catch (e) {
    killTree(child.pid);
    rmSync(appData, { recursive: true, force: true, maxRetries: 5 });
    throw e;
  }
}

/**
 * Brings a process's window to the foreground (helpers/front.ps1). With
 * `dialog`, the process's open dialog window, waited for until it opens. A
 * window already in front is left alone; otherwise the unlock key press it
 * sends (front.ps1) is input, so call it before a recording starts.
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
 * Waits until a file holds a whole JSON document and returns it parsed. The
 * app writes an export in one plain write, so an early read can see part of
 * it: a read that does not parse is retried until the deadline.
 */
export async function readJsonWhenWritten(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (e) {
        last = e;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `${path} held no whole JSON document within ${timeoutMs} ms: ${last ?? 'not written'}`,
  );
}

/**
 * Exports the open project through the panel's Export button and the app's
 * own save dialog, and returns the written document. The dialog is the app's
 * window, which the app does not record.
 */
export async function exportProject(app, file) {
  await app.panel.click('#btn-export-project');
  bringToFront(APP_PROCESS, { dialog: true });
  typeKeys([{ window: { process: `${APP_PROCESS}.exe` } }, { chars: file }, { key: 'enter' }]);
  return readJsonWhenWritten(file);
}

const reported = new WeakSet();

/**
 * What was on the screen when a test failed: the windows (printed, so the job
 * log has them) and a screenshot (attached to the test's results). The
 * fixtures call it as they end, before they end the app or Notepad, so every
 * spec that uses them gets the report; it runs once per test.
 */
function reportScreenOnFailure(testInfo) {
  if (testInfo.status === testInfo.expectedStatus || reported.has(testInfo)) return;
  reported.add(testInfo);
  const png = testInfo.outputPath('screen.png');
  const r = spawnSync('powershell', [...POWERSHELL, join(here, 'screen.ps1'), '-Png', png], {
    encoding: 'utf8',
  });
  console.log(`[screen] ${testInfo.title}\n${r.stdout}${r.stderr}`);
  if (existsSync(png))
    testInfo.attachments.push({ name: 'screen', path: png, contentType: 'image/png' });
}

/**
 * The suite's test. `app` is the built app, started fresh for the test;
 * `notepad` is Notepad, started for the test. Both end after it, and a failed
 * test reports the screen first.
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  notepad: async ({}, use, testInfo) => {
    const child = spawn('notepad.exe', [], { stdio: 'ignore' });
    try {
      await use(child);
    } finally {
      reportScreenOnFailure(testInfo);
      killTree(child.pid);
    }
  },
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use, testInfo) => {
    const app = await launchApp();
    try {
      await use(app);
    } finally {
      reportScreenOnFailure(testInfo);
      await app.close();
    }
  },
});

export { expect } from '@playwright/test';
