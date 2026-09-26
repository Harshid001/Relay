/**
 * Relay Store support backend - HTTP API composition root.
 *
 * Express 4, bound to 127.0.0.1:3000 only by default (set HOST/PORT to change).
 * Serves the production frontend from `dist/` with an SPA fallback and exposes
 * the customer + admin API contract.
 *
 * Modes:
 *   - demo (default): public local prototype. Every seeded conversation is marked
 *     `isDemo: true`; the frontend labels it. Admin routes are open on loopback.
 *   - live (CODEBUDDY_LIVE=true): requires ADMIN_TOKEN, otherwise startup fails.
 *
 * This file owns wiring and lifecycle only; the pieces live in focused modules:
 *   server/config.ts            environment config + Host/Origin guard
 *   server/validation.ts        request-body validation helpers
 *   server/routes/system.ts     health, metrics, OpenAPI, SSE
 *   server/routes/customer.ts   FAQs and customer conversations
 *   server/routes/admin.ts      queue, stats, FAQ writes, onboarding
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as auth from './auth.js';
import {
  ADMIN_AUTH_REQUIRED,
  HOST,
  LIVE,
  MODE,
  PORT,
  TRUST_PROXY_ENABLED,
  TRUST_PROXY_HOPS,
  hostOriginGuard,
} from './config.js';
import * as store from './db.js';
import { startEventBridge } from './events.js';
import { envelope, metricsMiddleware } from './http.js';
import { requestLogging } from './logger.js';
import { initMonitoring, initProcessErrorHandlers, reportError } from './monitoring.js';
import * as rateLimiters from './ratelimit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCustomerRoutes } from './routes/customer.js';
import { registerSystemRoutes } from './routes/system.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ *
 * App + middleware
 * ------------------------------------------------------------------ */

export const app = express();

app.disable('x-powered-by');
// Trust a fixed number of proxy hops (see server/config.ts) so Express resolves
// req.ip from X-Forwarded-For and secure-cookie detection keys on the client.
app.set('trust proxy', TRUST_PROXY_ENABLED ? TRUST_PROXY_HOPS : false);

/**
 * Standard security headers via helmet. The CSP allowlist covers the only
 * third parties the client loads: Google Identity Services (Auth.tsx injects
 * https://accounts.google.com/gsi/client) and the Inter typeface
 * (index.css @imports fonts.googleapis.com). React renders component styles
 * as inline `style` attributes, hence style-src 'unsafe-inline'. Everything
 * else is same-origin.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc: ["'self'", 'https://accounts.google.com'],
      },
    },
    // GSI may use popups during account selection; allow them while keeping
    // same-origin opener protection for everything else.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }),
);

// Mode header + Host/Origin allowlist (403 on mismatch).
app.use(hostOriginGuard);

app.use(express.json({ limit: '32kb' }));

// Correlated structured logs + Prometheus-style metrics for every request.
app.use(requestLogging());
app.use(metricsMiddleware());

// ---- API Router (/api/* and /api/v1/*) -------------------------------
// Mounts both legacy unwrapped (/api) and versioned enveloped (/api/v1).
export const apiRouter = express.Router();

registerSystemRoutes(apiRouter, { requireUser: auth.requireAuth });
registerCustomerRoutes(apiRouter);
registerAdminRoutes(apiRouter, {
  requireUser: auth.requireAuth,
  requireAdminRole: auth.requireRole('admin'),
});

// Auth: attach user session before API routing
app.use(auth.attachUser);
// Cookie sessions are ambient credentials: state-changing requests on them
// must carry the per-session CSRF token (header-token auth is exempt).
app.use(auth.requireCsrf);

// Versioned v1 API with standard envelope: { success, data | error }
const v1 = express.Router();
v1.use(envelope);
v1.use(apiRouter);
// Envelope v1 misses too, so the versioned contract stays consistent.
v1.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});
app.use('/api/v1', v1);

// Legacy unversioned API without envelope
app.use('/api', apiRouter);

/* ------------------------------------------------------------------ *
 * API 404 + static frontend + SPA fallback
 * ------------------------------------------------------------------ */

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

const DIST_CANDIDATES = [
  // Production layouts (Docker, compose): the frontend build sits next to
  // the backend folder, never inside the backend's own tsc output.
  path.resolve(store.PROJECT_ROOT, '../frontend/dist'),
  // Legacy single-folder layout: a dist/ with an index.html directly under
  // the project root (never the backend's compiled server output).
  path.join(store.PROJECT_ROOT, 'dist'),
];
const DIST_DIR =
  DIST_CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? DIST_CANDIDATES[1];
const INDEX_FILE = path.join(DIST_DIR, 'index.html');

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
}

// Browser navigation or direct access to system health
app.get('/admin/system-health', (req: Request, res: Response, next: NextFunction) => {
  if (req.accepts('json') && !req.accepts('html')) {
    res.redirect('/api/admin/system-health');
    return;
  }
  next();
});

app.get(/^\/(?!api(?:\/|$)).*/, (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (!fs.existsSync(INDEX_FILE)) {
    res.status(404).json({ error: 'Frontend build not found. Run the build first.' });
    return;
  }
  res.sendFile(INDEX_FILE);
});

/* ------------------------------------------------------------------ *
 * Error handler
 * ------------------------------------------------------------------ */

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const err = error as { type?: string; status?: number; statusCode?: number; message?: string };

  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  const status = err?.status ?? err?.statusCode ?? 500;
  void reportError('express', error, { path: _req.path, method: _req.method, status });
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: 'Internal server error' });
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

/**
 * Serverless entrypoint (api/index.ts): connect, seed and bootstrap on the
 * first request of each warm instance. Memoized so concurrent cold-start
 * invocations share one init; a failure clears the memo so the next request
 * retries instead of caching the error forever.
 */
let readyPromise: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  readyPromise ??= (async () => {
    initMonitoring();
    initProcessErrorHandlers();
    await store.connectToDatabase();
    await store.seedDatabase();
    await auth.initAuthCollections(store.getDb());
    await rateLimiters.initRateLimitCollections(store.getDb());
    await auth.bootstrapAdminFromEnv();
  })().catch((error: unknown) => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

export async function startServer(port: number = PORT, host: string = HOST) {
  initMonitoring();
  initProcessErrorHandlers();
  await store.connectToDatabase();
  await store.seedDatabase();
  await auth.initAuthCollections(store.getDb());
  await rateLimiters.initRateLimitCollections(store.getDb());
  await auth.bootstrapAdminFromEnv();
  // Cross-instance realtime (replica sets only); serverless stays in-process.
  await startEventBridge(store.getDb());

  const server = app.listen(port, host, () => {
    console.log(`[relay] Relay Store support backend listening on http://${host}:${port}`);
    console.log(`[relay] mode=${MODE} adminAuthRequired=${ADMIN_AUTH_REQUIRED} db=mongodb://${store.DB_NAME}`);
    if (!LIVE) {
      console.log('[relay] demo mode: public local prototype, seeded conversations are marked isDemo=true');
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`[relay] ${signal} received, shutting down…`);
    server.close(async () => {
      await store.closeDatabase();
      process.exit(0);
    });
    // Force-exit if connections do not drain in time.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  const self = normalize(__filename);
  const resolvedEntry = normalize(entry);
  return resolvedEntry === self || resolvedEntry === self.replace(/\.ts$/, '.js');
}

// Serverless runtimes (Vercel exports VERCEL=1) drive this module through
// api/index.ts — ensureReady() + the app per request, never app.listen().
if (isMainModule() && process.env.RELAY_NO_LISTEN !== '1' && !process.env.VERCEL) {
  startServer().catch((error) => {
    console.error('[relay] failed to start:', error);
    process.exit(1);
  });
}

export { store as dbStore };
export default app;
