import { defineConfig } from '@playwright/test';

/**
 * Single-browser (Chromium) pilot suite. The backend under test is launched
 * per worker by e2e/launch.ts against a throwaway database, so no webServer
 * block is needed here — but MONGODB_URI (or a local mongod with a replica
 * set) and a built frontend (relay/frontend/dist) are required.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    channel: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: [['list']],
});
