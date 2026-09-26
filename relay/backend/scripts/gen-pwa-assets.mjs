/**
 * One-shot PWA/social asset generator (PRD-016).
 *
 * Renders the SVG brand mark at exact pixel sizes with headless Chromium
 * (from the backend's @playwright/test install — no extra dependencies)
 * and writes PNGs into frontend/public/:
 *   icon-192.png, icon-512.png, icon-maskable-512.png, og-image.png
 *
 * Re-run after any brand change:
 *   node scripts/gen-pwa-assets.mjs   (from relay/backend/)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const project = fileURLToPath(new URL('../../', import.meta.url));
const pub = path.join(project, 'frontend/public');

const MARK = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#306645"/>
  <rect x="7" y="8" width="18" height="6.5" rx="3.25" fill="#d9ed9f"/>
  <rect x="7" y="17.5" width="18" height="6.5" rx="3.25" fill="#d9ed9f"/>
</svg>`;

const MASKABLE = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#306645"/>
  <g transform="translate(3.2,3.2) scale(0.8)">
    <rect width="32" height="32" rx="8" fill="#306645"/>
    <rect x="7" y="8" width="18" height="6.5" rx="3.25" fill="#d9ed9f"/>
    <rect x="7" y="17.5" width="18" height="6.5" rx="3.25" fill="#d9ed9f"/>
  </g>
</svg>`;

const OG = `
<html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#306645"/>
  <rect x="120" y="195" width="120" height="120" rx="30" fill="#3f7d53"/>
  <rect x="146" y="225" width="68" height="24" rx="12" fill="#d9ed9f"/>
  <rect x="146" y="261" width="68" height="24" rx="12" fill="#d9ed9f"/>
  <text x="280" y="255" font-family="Verdana, Geneva, sans-serif" font-size="72" font-weight="bold" fill="#ffffff">Relay</text>
  <text x="280" y="315" font-family="Verdana, Geneva, sans-serif" font-size="34" fill="#d9ed9f">Intelligent Customer Service</text>
  <text x="122" y="430" font-family="Verdana, Geneva, sans-serif" font-size="30" fill="#cfe0d2">AI first-line support grounded in your knowledge base,</text>
  <text x="122" y="472" font-family="Verdana, Geneva, sans-serif" font-size="30" fill="#cfe0d2">with instant human handoff when it matters.</text>
</svg>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();

async function shot(name, size, svg, viewport) {
  const v = viewport ?? { width: size, height: size };
  await page.setViewportSize(v);
  await page.setContent(`<html><body style="margin:0;background:#306645">${svg}</body></html>`);
  await page.screenshot({ path: path.join(pub, name), omitBackground: false });
  console.log(`wrote ${name} (${v.width}x${v.height})`);
}

await shot('icon-192.png', 192, MARK(192));
await shot('icon-512.png', 512, MARK(512));
await shot('icon-maskable-512.png', 512, MASKABLE(512));
await page.setViewportSize({ width: 1200, height: 630 });
await page.setContent(OG);
await page.screenshot({ path: path.join(pub, 'og-image.png') });
console.log('wrote og-image.png (1200x630)');

await browser.close();
