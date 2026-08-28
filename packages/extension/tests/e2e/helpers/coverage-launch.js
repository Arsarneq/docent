/**
 * coverage-launch.js — the launch fixtures the two coverage specs share:
 * a per-test profile directory, the extension-loaded persistent context
 * launched with `--remote-debugging-port=0`, and the ephemeral CDP port the
 * browser actually bound.
 *
 * The fixtures own the profile directory because they must read the
 * DevToolsActivePort file Chrome writes there (`devtools-port.js`): with
 * port 0 the OS assigns the CDP port, so simultaneous runs can never
 * collide on a fixed one.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';
import { readDevToolsPort } from './devtools-port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../..');

/** Spread into a coverage spec's `base.extend({...})`. */
export const coverageLaunchFixtures = {
  profileDir: async ({}, use) => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'docent-e2e-coverage-'));
    await use(dir);
    // Retries tolerate the transient EBUSY a just-closed browser's open
    // handles can cause on Windows.
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  },

  context: async ({ profileDir }, use) => {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--disable-default-apps',
        '--remote-debugging-port=0',
      ],
    });
    await use(context);
    await context.close();
  },

  // The CDP port this context's browser actually bound, for the raw-CDP
  // service-worker connection the coverage specs open.
  debugPort: async ({ context, profileDir }, use) => {
    // Depending on `context` orders this after the launch — Chrome writes
    // DevToolsActivePort during startup.
    void context;
    await use(await readDevToolsPort(profileDir));
  },
};
