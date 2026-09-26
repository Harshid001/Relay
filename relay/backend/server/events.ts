/**
 * Workspace event bus feeding the admin SSE stream.
 *
 * Delivery is cross-instance when the database supports change streams
 * (replica set: Atlas, docker-compose, CI): a published event is inserted into
 * `realtime_events` (TTL 60s) and every instance's change-stream listener
 * fans it out to its own SSE clients. On a standalone mongod — and in
 * serverless invocations, where long-lived cursors are not viable — the bus
 * falls back to in-process delivery, and the workspace UI's polling remains
 * the safety net.
 *
 * Every conversation or FAQ mutation emits a `workspace` event; admin clients
 * subscribe at /api/admin/events and refresh the affected slice. The same emit
 * helper also triggers email notifications so all triggers live in one place.
 */

import crypto from 'node:crypto';
import type { Response } from 'express';
import type { Collection, Db } from 'mongodb';

import { log } from './logger.js';
import { notifyOnEvent } from './notify.js';
import { telemetry } from './telemetry.js';

export type WorkspaceEvent =
  | { type: 'conversation'; id: string; status: string | null }
  | { type: 'faq' };

interface Client {
  id: number;
  res: Response;
}

interface RealtimeEventDoc {
  _id?: unknown;
  origin: string;
  event: WorkspaceEvent;
  created_at: Date;
}

/** Identifies this process so it can ignore its own relayed events. */
const INSTANCE_ID = crypto.randomBytes(8).toString('hex');

let nextClientId = 1;
const clients = new Map<number, Client>();

/** Cross-instance bridge state; null when running in-process only. */
let bridge: { collection: Collection<RealtimeEventDoc> } | null = null;

function deliver(event: WorkspaceEvent): void {
  telemetry.setSseSubscribers(clients.size);
  if (clients.size === 0) return;
  const payload = `event: workspace\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients.values()) {
    try {
      if (client.res.writableEnded || client.res.destroyed) {
        clients.delete(client.id);
        continue;
      }
      client.res.write(payload);
    } catch {
      telemetry.recordSseFailure();
      clients.delete(client.id);
    }
  }
  telemetry.setSseSubscribers(clients.size);
}

/**
 * Publishes an event. Local clients are always served immediately; when the
 * bridge is active the event is also inserted so other instances relay it to
 * their clients (this instance ignores its own origin to avoid duplicates).
 */
export function publish(event: WorkspaceEvent): void {
  deliver(event);
  if (!bridge) return;
  bridge.collection
    .insertOne({ origin: INSTANCE_ID, event, created_at: new Date() })
    .catch((error: unknown) => {
      // Local delivery already happened; the relay is best-effort.
      log.error('realtime_publish_failed', { error: String(error) });
    });
}

/**
 * Starts the change-stream listener so events reach clients on every instance.
 * Requires a replica set; on a standalone server this logs and stays in-process.
 */
export async function startEventBridge(db: Db): Promise<void> {
  const collection = db.collection<RealtimeEventDoc>('realtime_events');
  try {
    await collection.createIndex({ created_at: 1 }, { expireAfterSeconds: 60 });
    const stream = collection.watch<RealtimeEventDoc>([], { fullDocument: 'updateLookup' });
    stream.on('change', (change) => {
      const doc = change.operationType === 'insert' ? change.fullDocument : null;
      // Skip our own events: publish() already delivered them locally.
      if (doc?.event && doc.origin !== INSTANCE_ID) {
        deliver(doc.event);
      }
    });
    stream.on('error', (error) => {
      telemetry.recordSseFailure();
      log.error('realtime_stream_error', { error: String(error) });
      bridge = null;
    });
    bridge = { collection };
    log.info('realtime_bridge_started', {});
  } catch (error) {
    // Standalone mongod has no change streams; the client's polling fallback
    // still covers cross-instance updates.
    log.warn('realtime_bridge_unavailable', { error: String(error) });
    bridge = null;
  }
}

/** Registers an SSE response; returns a cleanup function. */
export function subscribe(res: Response): () => void {
  const id = nextClientId++;
  clients.set(id, { id, res });
  telemetry.setSseSubscribers(clients.size);

  const cleanup = () => {
    clients.delete(id);
    telemetry.setSseSubscribers(clients.size);
  };

  res.on('error', () => {
    telemetry.recordSseFailure();
    cleanup();
  });

  return cleanup;
}

export function subscriberCount(): number {
  return clients.size;
}

/**
 * Publishes a conversation event and triggers any email notification. Single
 * entry point so realtime fan-out and email stay in sync (see notify.ts).
 */
export function emitConversation(id: string, status: string | null, title?: string): void {
  publish({ type: 'conversation', id, status });
  void notifyOnEvent({ type: 'conversation', id, status }, title);
}
