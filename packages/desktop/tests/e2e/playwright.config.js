/**
 * The desktop end-to-end suite: the built app on Windows, its panel driven
 * over WebView2's DevTools port, other programs and dialogs given real
 * keyboard and mouse input by the driver in `driver/`.
 *
 * One worker: the tests share the machine's one keyboard, mouse and
 * foreground window. A failed test runs once more to keep a trace, and a test that
 * passes only on that retry fails the run (`failOnFlakyTests`).
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,
  failOnFlakyTests: true,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
  },
});
