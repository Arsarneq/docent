/**
 * Playwright config for the scripted-truth capture corpus (corpus/ at the repo
 * root). Separate from the main e2e config so the corpus keeps its own
 * determinism regime: fixed viewport, the fixed-port page server (webServer —
 * started once per run, killed with it; reuseExistingServer off so a port
 * collision fails at startup, never mid-retry), and produce-stage retries
 * whose oracle is the corpus comparator itself (a persistent truth mismatch
 * stays red; a timing flake gets retried).
 */

import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

export default defineConfig({
  testDir: './corpus',
  timeout: 30_000,
  retries: 3,
  workers: 1, // sessions share chrome.storage.local — never parallel
  reporter: process.env.CI ? 'dot' : 'list',
  use: { trace: 'on-first-retry' },
  webServer: {
    command: `node ${path.join(repoRoot, 'corpus', 'serve.js')}`,
    url: 'http://127.0.0.1:41730/health',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 15_000,
  },
});
