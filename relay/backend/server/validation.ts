/**
 * Request-body validation helpers shared by the route groups.
 *
 * Values are bounded and normalised here so handlers stay free of ad-hoc
 * coercion; anything that fails returns `null` and the caller answers 400.
 */

import { INTENTS, type Intent } from './knowledge.js';

export const MAX_CONTENT = 4000;
export const MAX_EMAIL = 200;
export const MAX_CUSTOMER = 80;
export const MAX_REASON = 300;
export const MAX_TITLE = 200;
export const MAX_ANSWER = 4000;
export const MAX_ASSIGNEE = 80;
export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 40;
export const MAX_CLIENT_ID = 120;

export function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function readRequiredString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export function readOptionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

export function parseIntent(value: unknown): Intent | null {
  return typeof value === 'string' && (INTENTS as string[]).includes(value)
    ? (value as Intent)
    : null;
}

export function parseTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_TAGS) return null;
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const tag = entry.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return null;
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}
