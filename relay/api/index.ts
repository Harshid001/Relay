/**
 * Vercel serverless entrypoint.
 *
 * This file MUST live in <project-root>/api/ (here, relay/api/): Vercel only
 * discovers serverless functions in the root-level api/ directory, and the
 * vercel.json `functions` glob keys match paths relative to the project
 * root. vercel.json routes every /api/* request here. The Express app from
 * backend/server/index.ts is invoked per request; ensureReady() connects,
 * seeds and bootstraps on the first call of each warm instance (memoized).
 * Static files are served by Vercel's CDN from frontend/dist/ — the in-app
 * static serving skips itself automatically because no dist/ is part of the
 * function bundle.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import app, { ensureReady } from '../backend/server/index.js';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ensureReady();
  } catch (error) {
    console.error('[relay] initialization failed:', error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Database unavailable' }));
    return;
  }
  // Express apps are Node request listeners: (req, res, next) => void.
  (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
