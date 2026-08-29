import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: 3, // Retry up to 3 times (4 total attempts) to handle timing flakes.
  workers: 1, // Extensions share chrome.storage.local — parallel execution causes race conditions.
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  use: {
    // Capture trace on first retry — helps diagnose flaky failures.
    trace: 'on-first-retry',
  },
  projects: [
    {
      // Launch flags live with the launchers, not here: every spec runs the
      // extension in a persistent context created by the shared fixture (or a
      // local in-file fixture), whose chromium.launchPersistentContext call
      // takes its own options. The runner merges its defaults underneath a
      // caller's — each launcher's options win per key, and a launcher's args
      // replace the config's wholesale — so keeping the flags with the
      // launchers is what keeps one launcher's args readable in one place.
      name: 'chromium',
    },
  ],
});
