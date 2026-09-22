/**
 * Tiny in-process pub/sub event bus feeding the admin SSE stream.
 *
 * Single-instance by design (matches the in-memory rate limits). Every
 * conversation or FAQ mutation emits a `workspace` event; admin clients
 * subscribe at /api/admin/events and refresh the affected slice. Email
 * notifications subscribe the same way, so all triggers live in one place.
 */

import type { Response } from 'express';

export type WorkspaceEvent =
  | { type: 'conversation'; id: string; status: string | null }
  | { type: 'faq' };

interface Client {
  id: number;
  res: Response;
}

let nextClientId = 1;
const clients = new Map<number, Client>();

/** Publishes an event to every connected admin client. Never throws. */
export function publish(event: WorkspaceEvent): void {
  if (clients.size === 0) return;
  const payload = `event: workspace\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients.values()) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client.id);
    }
  }
}

/** Registers an SSE response; returns a cleanup function. */
export function subscribe(res: Response): () => void {
  const id = nextClientId++;
  clients.set(id, { id, res });
  return () => {
    clients.delete(id);
  };
}

export function subscriberCount(): number {
  return clients.size;
}
