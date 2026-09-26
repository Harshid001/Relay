/**
 * Uniform HTTP response helpers.
 *
 * All handlers keep writing their plain JSON payloads. The versioned mount
 * (/api/v1) wraps them into the standard envelope:
 *   { "success": true,  "data": … }
 *   { "success": false, "error": { "code": …, "message": … } }
 * The legacy /api mount stays unwrapped for backward compatibility.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

const STATUS_TO_CODE: Record<number, string> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.VALIDATION_ERROR,
  429: ErrorCode.RATE_LIMITED,
};

function codeForStatus(status: number): string {
  return STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL;
}

/** Standard success envelope. */
export function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ success: true, data });
}

/** Standard error envelope (also usable directly by handlers). */
export function fail(
  res: Response,
  status: number,
  message: string,
  details?: unknown,
): void {
  res.status(status).json({
    success: false,
    error: { code: codeForStatus(status), message, details },
  });
}

/**
 * Mount-level middleware: patches res.json so every payload leaving the
 * versioned API is enveloped. Raw `{ error: string }` bodies become
 * `{ success: false, error: { code, message } }`; everything else becomes
 * `{ success: true, data }`. Already-enveloped bodies pass through untouched.
 */
export function envelope(_req: Request, res: Response, next: NextFunction): void {
  const rawJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      'success' in (body as Record<string, unknown>)
    ) {
      return rawJson(body);
    }
    if (
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).error === 'string' &&
      res.statusCode >= 400
    ) {
      const message = (body as { error: string }).error;
      return rawJson({
        success: false,
        error: { code: codeForStatus(res.statusCode), message },
      });
    }
    return rawJson({ success: true, data: body });
  }) as typeof res.json;
  next();
}

/** Metrics counters exposed at /api/metrics in Prometheus text format. */
const counters = {
  requestsTotal: 0,
  errorsTotal: 0,
} as Record<string, number>;

const latencyBuckets = [5, 25, 100, 500, 2000];
const latencyCounts = new Array(latencyBuckets.length + 1).fill(0) as number[];

import { telemetry } from './telemetry.js';

export function metricsMiddleware(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    counters.requestsTotal += 1;
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (res.statusCode >= 500) counters.errorsTotal += 1;
      telemetry.recordHttp(res.statusCode, ms);

      const index = latencyBuckets.findIndex((bucket) => ms < bucket);
      latencyCounts[index === -1 ? latencyBuckets.length : index] += 1;
    });
    next();
  };
}

export function metricsText(): string {
  const lines: string[] = [
    '# TYPE relay_requests_total counter',
    `relay_requests_total ${counters.requestsTotal}`,
    '# TYPE relay_errors_total counter',
    `relay_errors_total ${counters.errorsTotal}`,
    '# TYPE relay_request_duration_seconds bucket',
  ];
  let cumulative = 0;
  latencyBuckets.forEach((bucket, index) => {
    cumulative += latencyCounts[index];
    lines.push(`relay_request_duration_seconds{le="${bucket / 1000}"} ${cumulative}`);
  });
  lines.push(
    `relay_request_duration_seconds{le="+Inf"} ${cumulative + latencyCounts[latencyBuckets.length]}`,
  );
  return `${lines.join('\n')}\n`;
}
