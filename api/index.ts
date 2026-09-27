import type { IncomingMessage, ServerResponse } from 'node:http';

import app, { ensureReady } from '../relay/backend/dist/server/index.js';

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
  (app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
