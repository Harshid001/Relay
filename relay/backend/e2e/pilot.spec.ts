import type { ChildProcess } from 'node:child_process';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

import { launchServer, stopServer } from './launch';

/**
 * Pilot flow, end to end through a real browser against a real server:
 * landing → customer chat Q&A with citation → human handoff → admin
 * password login (cookie session + CSRF, exactly like production) →
 * queue → reply → resolve.
 *
 * Prerequisites: MongoDB reachable (MONGODB_URI or 127.0.0.1:27017) and
 * the frontend built (`npm run build` in relay/frontend) — the backend
 * serves ../frontend/dist itself, so one server covers UI and API.
 */

let base = '';
let proc: ChildProcess | null = null;
// One shared page for the whole pilot: the customer session (localStorage)
// and the admin session (cookie) must persist across the flow, exactly as
// they do for a real user walking through the product.
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const launched = await launchServer();
  proc = launched.proc;
  base = launched.url;
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close().catch(() => undefined);
  if (proc) await stopServer(proc);
});

async function dismissOverlays(): Promise<void> {
  for (const label of ['Dismiss setup guide', 'Dismiss demo banner', 'Dismiss message']) {
    const button = page.getByRole('button', { name: label });
    if (await button.isVisible().catch(() => false)) {
      await button.click();
    }
  }
}

test.describe.serial('pilot flow', () => {
  test('landing renders and the demo CTA opens the chat', async () => {
    await page.goto(`${base}/`);
    await expect(page.getByRole('heading', { name: /AI handles the repetitive/ })).toBeVisible();
    await page.getByRole('button', { name: /Launch AI support for free/ }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByLabel('Support chat')).toBeVisible();
  });

  test('customer gets a cited refund answer, not a guess', async () => {
    await page.goto(`${base}/chat`);
    await expect(page.getByLabel('Support chat')).toBeVisible();
    await page.getByLabel('Message Relay Assistant').fill('What is your refund policy?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const chat = page.getByLabel('Support chat');
    await expect(chat).toContainText(/30 days of delivery/, { timeout: 15000 });
  });

  test('customer requests a human and the request sticks', async () => {
    await page.getByRole('button', { name: 'Request a human' }).click();
    await expect(page.getByRole('button', { name: 'Human requested' })).toBeVisible({ timeout: 15000 });
  });

  test('admin signs in with a password (cookie session + CSRF)', async () => {
    await page.goto(`${base}/app`);
    await page.getByRole('tab', { name: 'Password' }).click();
    await page.getByLabel('Email').fill('e2e-owner@relay.test');
    await page.getByLabel('Password').fill('e2e-owner-pass-123');
    await page.getByRole('button', { name: 'Sign in with password' }).click();
    await expect(page.getByLabel('Workspace navigation')).toBeVisible({ timeout: 15000 });
  });

  test('admin finds the handoff, replies, and resolves it', async () => {
    console.log(`queue test start: url=${page.url()}`);
    await expect(page.getByLabel('Workspace navigation')).toBeVisible({ timeout: 15000 });
    await dismissOverlays();
    await page.getByRole('button', { name: 'Conversations' }).click();
    await page.getByRole('tab', { name: /Needs a human/ }).click();
    await page.locator('tbody tr').first().click();
    // Exact match: the drawer's own close button ("Close conversation
    // detail") would otherwise match the same accessible-name substring.
    const drawer = page.getByLabel('Conversation detail', { exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByLabel('Reply to the customer').fill('Thanks for reaching out — I have taken over and will sort this out now.');
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    await expect(drawer).toContainText('Thanks for reaching out', { timeout: 15000 });
    await drawer.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'Resolved', exact: true })).toBeVisible({ timeout: 15000 });
  });

  test('security headers ship on the served UI', async ({ request }) => {
    const response = await request.get(`${base}/`);
    expect(response.ok()).toBeTruthy();
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/fonts\.googleapis\.com/);
    expect(response.headers()['strict-transport-security']).toBeTruthy();
    expect(response.headers()['x-frame-options']).toBe('SAMEORIGIN');
  });
});
