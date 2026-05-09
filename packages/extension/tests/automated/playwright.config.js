import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 3, // Retry up to 3 times (4 total attempts) to handle timing flakes.
  workers: 1, // Extensions share chrome.storage.local — parallel execution causes race conditions.
  use: {
    // Capture trace on first retry — helps diagnose flaky failures.
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-first-run',
            '--disable-default-apps',
          ],
        },
      },
    },
  ],
});
