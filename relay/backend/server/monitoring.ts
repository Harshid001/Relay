/**
 * Error tracking, performance monitoring & alerting.
 *
 * Two independent, optional sinks:
 *   1. Sentry (`SENTRY_DSN`) — managed APM with alert routing, releases and
 *      source maps. When configured, Sentry owns process-level handlers.
 *   2. A generic JSON webhook (`ERROR_WEBHOOK_URL`) — dependency-free fallback
 *      for teams without Sentry (Slack/collector-compatible payload).
 *
 * With neither set, behaviour is unchanged: structured error lines via
 * server/logger.ts. Reporting is fire-and-forget; it never breaks a request.
 */

import * as Sentry from '@sentry/node';

import { log } from './logger.js';

const SENTRY_DSN = (process.env.SENTRY_DSN ?? '').trim();
const WEBHOOK_URL = (process.env.ERROR_WEBHOOK_URL ?? '').trim();
const WEBHOOK_TIMEOUT_MS = 5_000;

let sentryReady = false;

/** Initialises Sentry once, when a DSN is configured. Safe to call repeatedly. */
export function initMonitoring(): void {
  if (!SENTRY_DSN || sentryReady) return;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: (process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development').trim(),
    release: (process.env.SENTRY_RELEASE ?? '').trim() || undefined,
    tracesSampleRate: Math.min(1, Math.max(0, Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0) || 0)),
  });
  sentryReady = true;
  log.info('monitoring_sentry_enabled', { environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV });
}

export function monitoringEnabled(): boolean {
  return SENTRY_DSN.length > 0 || WEBHOOK_URL.length > 0;
}

export async function reportError(
  source: string,
  error: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  log.error('monitoring_error', { source, message, ...context });

  if (sentryReady) {
    try {
      Sentry.withScope((scope) => {
        scope.setTag('source', source);
        scope.setContext('relay', context);
        Sentry.captureException(error instanceof Error ? error : new Error(message));
      });
    } catch (sentryError) {
      log.error('monitoring_sentry_failed', { error: String(sentryError) });
    }
  }

  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, message, stack, context, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (sendError) {
    log.error('monitoring_webhook_failed', { error: String(sendError) });
  }
}

let handlersInstalled = false;

/**
 * Installs process-level reporters for the webhook-only path. When Sentry is
 * configured its default integrations own uncaught exceptions/rejections, so
 * we skip ours to avoid duplicate captures. With neither sink, Node's default
 * crash semantics are preserved.
 */
export function initProcessErrorHandlers(): void {
  if (handlersInstalled || SENTRY_DSN || !WEBHOOK_URL) return;
  handlersInstalled = true;

  process.on('unhandledRejection', (reason) => {
    void reportError('unhandledRejection', reason);
  });
  process.on('uncaughtException', (error) => {
    void reportError('uncaughtException', error);
    // Match Node's default: an uncaught exception is unrecoverable.
    process.exit(1);
  });
}
