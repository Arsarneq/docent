import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 15_000,
  retries: 1,
  workers: 1,
  globalTeardown: './global-teardown.js',
  use: {
    headless: true,
  },
});
