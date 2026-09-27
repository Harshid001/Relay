/**
 * Vercel serverless entrypoint for standalone backend deployment.
 *
 * Discovered by Vercel in <backend-root>/api/index.ts.
 * Routes /api/* requests to the Express app with memoized warm database initialization.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import app, { ensureReady } from '../server/index.js';

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
