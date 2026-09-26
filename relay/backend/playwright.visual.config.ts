import { defineConfig } from '@playwright/test';

/**
 * Opt-in visual regression config. Kept separate from playwright.config.ts so
 * the screenshot suite never runs as part of the default E2E job (baselines are
 * platform-rendered). Generate them on the target platform with:
 *
 *   npm run test:visual -- --update-snapshots
 *
 * Requires MongoDB and a built frontend, like the rest of the e2e suite.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/visual.check.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: { channel: 'chromium' },
  reporter: [['list']],
  updateSnapshots: 'missing',
});
