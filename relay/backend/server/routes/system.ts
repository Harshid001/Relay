/**
 * System routes: health, metrics, OpenAPI, system health and the admin SSE
 * stream. Mounted on both /api and /api/v1 (the versioned mount envelopes).
 */

import type { Request, RequestHandler, Response, Router } from 'express';

import { authRouter } from '../auth-routes.js';
import { ADMIN_AUTH_REQUIRED, LIVE, MODE, TRUST_PROXY_ENABLED } from '../config.js';
import * as store from '../db.js';
import { subscriberCount, subscribe } from '../events.js';
import { metricsText, wrap } from '../http.js';
import { monitoringEnabled } from '../monitoring.js';
import { openapi } from '../openapi.js';
import { telemetry } from '../telemetry.js';

export function registerSystemRoutes(router: Router, deps: { requireUser: RequestHandler }): void {
  router.get('/health', wrap(async (_req: Request, res: Response) => {
    const ping = await store.pingDatabase();
    const database = ping.ok ? 'up' : 'down';
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      mode: MODE,
      checks: { database },
      adminAuthRequired: ADMIN_AUTH_REQUIRED,
      plan: 'free',
      trustProxy: TRUST_PROXY_ENABLED,
      monitoring: monitoringEnabled(),
    });
  }));

  router.get('/metrics', (_req: Request, res: Response) => {
    res.type('text/plain; version=0.0.4').send(metricsText());
  });

  router.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(openapi);
  });

  const systemHealth = wrap(async (_req: Request, res: Response) => {
    const ping = await store.pingDatabase();
    const faqCount = await store.countFaqs();
    const report = telemetry.getSnapshot({
      dbConnected: ping.ok,
      dbPingLatencyMs: ping.ok ? ping.latencyMs : null,
      isLive: LIVE,
      faqCount,
      activeSseCount: subscriberCount(),
    });
    res.status(report.status === 'unhealthy' ? 503 : 200).json(report);
  });

  router.get('/admin/system-health', deps.requireUser, systemHealth);
  router.get('/health/system', systemHealth);

  // Auth router mounted on /api/auth and /api/v1/auth
  router.use('/auth', authRouter);

  // Admin SSE stream
  router.get('/admin/events', deps.requireUser, (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const unsubscribe = subscribe(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* cleanup below handles removal */
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
}
