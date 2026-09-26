import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';

import { launchServer, stopServer } from './launch';

/**
 * Visual regression checks for the public surfaces. Opt-in (not part of the
 * default `npm run test:e2e` suite) because screenshot baselines are rendered
 * per platform: generate them on the platform you intend to gate with
 *
 *   npm run test:visual -- --update-snapshots
 *
 * Prerequisites are the same as pilot.spec.ts (MongoDB + built frontend).
 * Comparisons disable animations and tolerate a small pixel ratio so font
 * antialiasing alone does not fail the run.
 */

let base = '';
let proc: ChildProcess | null = null;

test.beforeAll(async () => {
  const launched = await launchServer();
  proc = launched.proc;
  base = launched.url;
});

test.afterAll(async () => {
  if (proc) await stopServer(proc);
});

const SURFACES = [
  { name: 'landing', path: '/', ready: /AI handles the repetitive/ },
  { name: 'chat', path: '/chat', ready: 'Support chat' },
  { name: 'login', path: '/app', ready: /Sign in to the workspace/ },
] as const;

test.describe.serial('visual regression', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} matches its baseline`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${base}${surface.path}`);
      await expect(
        typeof surface.ready === 'string'
          ? page.getByLabel(surface.ready)
          : page.getByRole('heading', { name: surface.ready }),
      ).toBeVisible({ timeout: 15000 });
      await expect(page).toHaveScreenshot(`${surface.name}.png`, {
        animations: 'disabled',
        maxDiffPixelRatio: 0.02,
      });
    });
  }
});
