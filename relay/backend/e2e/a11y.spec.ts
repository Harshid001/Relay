import type { ChildProcess } from 'node:child_process';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { launchServer, stopServer } from './launch';

/**
 * Accessibility regression scans over the three public surfaces. Any new
 * violation fails the suite — fix the markup, not the test.
 *
 * Prerequisites: same as pilot.spec.ts (MongoDB + built frontend).
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

async function expectNoViolations(page: import('@playwright/test').Page, scope?: string): Promise<void> {
  const builder = new AxeBuilder({ page });
  if (scope) builder.include(scope);
  const results = await builder.analyze();
  expect(
    results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.help}`),
    scope ?? 'page',
  ).toEqual([]);
}

test.describe.serial('accessibility', () => {
  test('landing has no violations', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.getByRole('heading', { name: /AI handles the repetitive/ })).toBeVisible();
    await expectNoViolations(page);
  });

  test('customer chat has no violations', async ({ page }) => {
    await page.goto(`${base}/chat`);
    await expect(page.getByLabel('Support chat')).toBeVisible();
    await page.getByLabel('Message Relay Assistant').fill('What is your refund policy?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByLabel('Support chat')).toContainText(/30 days of delivery/, {
      timeout: 15000,
    });
    await expectNoViolations(page);
  });

  test('workspace login has no violations', async ({ page }) => {
    await page.goto(`${base}/app`);
    await expect(page.getByRole('heading', { name: /Sign in to the workspace/ })).toBeVisible();
    await expectNoViolations(page);
  });
});
