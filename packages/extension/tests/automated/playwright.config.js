import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 0,
  use: {
    // No default browser — we configure it per-project below.
  },
  projects: [
    {
      name: 'chromium',
      use: {
        // Launch Chromium with the extension loaded.
        // Playwright's chromium doesn't support extensions, so we use the
        // channel: 'chrome' to use the system Chrome, or launch with args.
        launchOptions: {
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
            '--no-first-run',
            '--disable-default-apps',
          ],
          // Extensions only work in headed mode with a persistent context,
          // but we handle that in the test helper (global setup).
        },
      },
    },
  ],
});
