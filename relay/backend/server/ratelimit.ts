/**
 * Abuse controls backed by MongoDB, so they hold across instances.
 *
 * - Rate limits: fixed-window atomic counters in `rate_limits` (TTL-cleaned).
 *   The key includes the caller's IP exactly like the old in-memory buckets,
 *   so single-instance behavior is unchanged; multi-instance deployments now
 *   share one budget instead of granting N x the budget.
 * - Turn locks: one document per in-flight assistant turn in `turn_locks`.
 *   The TTL doubles as crash recovery — the old in-memory Set leaked a lock
 *   forever when the process died mid-turn.
 *
 * On a store error the limiter fails open (the outage is already reported by
 * the health endpoints; refusing all traffic would turn a Mongo blip into a
 * full outage), while lock acquisition fails closed (a duplicate assistant
 * turn is worse than a 500 the client can retry idempotently).
 */

import crypto from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { RequestHandler } from 'express';

import { getDb } from './db.js';

interface RateLimitDoc {
  _id: string; // `${bucket}|${windowStart}`
  count: number;
  expires_at: Date;
}

interface TurnLockDoc {
  _id: string; // conversation id
  owner: string; // instance id, for future lock-stealing diagnostics
  expires_at: Date;
}

const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

function rateLimits(): Collection<RateLimitDoc> {
  return getDb().collection<RateLimitDoc>('rate_limits');
}

function turnLocks(): Collection<TurnLockDoc> {
  return getDb().collection<TurnLockDoc>('turn_locks');
}

export async function initRateLimitCollections(db: Db): Promise<void> {
  await Promise.all([
    db
      .collection<RateLimitDoc>('rate_limits')
      .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    db
      .collection<TurnLockDoc>('turn_locks')
      .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);
}

export interface RateVerdict {
  allowed: boolean;
  retryAfterSec: number;
}

export async function checkRateLimit(bucket: string, max: number, windowMs: number): Promise<RateVerdict> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const after = await rateLimits().findOneAndUpdate(
    { _id: `${bucket}|${windowStart}` },
    {
      $inc: { count: 1 },
      $setOnInsert: { expires_at: new Date(windowStart + windowMs * 2) },
    },
    { upsert: true, returnDocument: 'after' },
  );
  // Null can only mean a driver anomaly: fail closed.
  const count = after?.count ?? max + 1;
  if (count <= max) return { allowed: true, retryAfterSec: 0 };
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}

/**
 * Generic fixed-window counters for controls that must count only some events
 * (e.g. failed logins) rather than every request. Keys are namespaced with a
 * `c:` prefix so they cannot collide with the request-rate buckets above.
 */
function counterId(key: string, windowMs: number): string {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  return `c:${key}|${windowStart}`;
}

/** Increments a counter for the current window and returns the new value. */
export async function bumpCounter(key: string, windowMs: number): Promise<number> {
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const after = await rateLimits().findOneAndUpdate(
    { _id: counterId(key, windowMs) },
    {
      $inc: { count: 1 },
      $setOnInsert: { expires_at: new Date(windowStart + windowMs * 2) },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return after?.count ?? 1;
}

/** Reads the current window's counter value (0 when none exists). */
export async function readCounter(key: string, windowMs: number): Promise<number> {
  const doc = await rateLimits().findOne({ _id: counterId(key, windowMs) }, { projection: { count: 1 } });
  return doc?.count ?? 0;
}

/** Clears a counter for the current window (e.g. after a successful login). */
export async function resetCounter(key: string, windowMs: number): Promise<void> {
  await rateLimits().deleteOne({ _id: counterId(key, windowMs) });
}

export function rateLimit(name: string, max: number, windowMs: number): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      let verdict: RateVerdict;
      try {
        verdict = await checkRateLimit(`${name}|${req.ip ?? 'unknown'}`, max, windowMs);
      } catch {
        next();
        return;
      }
      if (!verdict.allowed) {
        res.setHeader('Retry-After', String(verdict.retryAfterSec));
        res.status(429).json({ error: 'Too many requests. Please slow down.' });
        return;
      }
      next();
    })().catch(next);
  };
}

/**
 * Claims the turn lock for a conversation. Returns false when another
 * instance (or this one) already holds it. Stale locks expire via TTL.
 */
export async function acquireTurnLock(conversationId: string, ttlMs = 120_000): Promise<boolean> {
  try {
    await turnLocks().insertOne({
      _id: conversationId,
      owner: INSTANCE_ID,
      expires_at: new Date(Date.now() + ttlMs),
    });
    return true;
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return false;
    throw error;
  }
}

export async function releaseTurnLock(conversationId: string): Promise<void> {
  await turnLocks().deleteOne({ _id: conversationId });
}
