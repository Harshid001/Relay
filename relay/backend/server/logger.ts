/**
 * Structured request logging with correlation IDs.
 *
 * Every request gets an `x-request-id` (client-supplied IDs are honoured so
 * traces can cross systems) and one JSON log line on completion. Replace the
 * `emit` function with a proper transport (pino, OTLP, …) without touching
 * the call sites.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/** Assigns a request ID, sets the response header, logs one line per request. */
export function requestLogging(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    const requestId =
      incoming && /^[\w.-]{8,64}$/.test(incoming)
        ? incoming
        : crypto.randomUUID().slice(0, 18);

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      emit('info', 'http_request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      });
    });

    next();
  };
}
