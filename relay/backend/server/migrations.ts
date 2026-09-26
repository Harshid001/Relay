/**
 * Schema migrations.
 *
 * The store is MongoDB, so instead of SQL migrations this runner applies
 * versioned, idempotent steps exactly once (tracked in `schema_migrations`).
 * It runs right after index creation in `connectToDatabase`, so every
 * deployment path — tsx dev, compiled `dist`, serverless `ensureReady` — gets
 * the same schema state.
 *
 * Migration 001 installs `$jsonSchema` validators so the database rejects
 * malformed documents at the storage layer, not only at the HTTP layer. They
 * use `validationLevel: 'moderate'` (validate inserts and updates of already
 * valid documents) so pre-existing documents are never broken by the upgrade.
 */

import type { Db } from 'mongodb';

import { log } from './logger.js';

interface MigrationDoc {
  _id: string;
  applied_at: string;
}

interface Migration {
  id: string;
  up: (db: Db) => Promise<void>;
}

const INTENTS = ['refund', 'order', 'technical', 'general'] as const;
const MESSAGE_ROLES = ['user', 'assistant', 'human', 'system'] as const;
const MESSAGE_PROVIDERS = ['demo', 'codebuddy', 'human'] as const;
const ROLES = ['admin', 'agent'] as const;

const CONVERSATION_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'customer', 'title', 'intent', 'status', 'token_hashes', 'created_at', 'updated_at'],
  properties: {
    _id: { bsonType: 'string' },
    customer: { bsonType: 'string' },
    email: { bsonType: 'string' },
    title: { bsonType: 'string' },
    intent: { enum: [...INTENTS] },
    status: { enum: ['open', 'waiting', 'resolved'] },
    escalation_reason: { bsonType: ['string', 'null'] },
    assignee: { bsonType: ['string', 'null'] },
    rating: { bsonType: ['int', 'double', 'null'] },
    is_demo: { bsonType: 'bool' },
    low_confidence_streak: { bsonType: ['int', 'long', 'double'] },
    unresolved_streak: { bsonType: ['int', 'long', 'double'] },
    preview: { bsonType: 'string' },
    human_handled: { bsonType: 'bool' },
    token_hashes: { bsonType: 'array', items: { bsonType: 'string' } },
  },
} as const;

const MESSAGE_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'conversation_id', 'role', 'content', 'created_at'],
  properties: {
    _id: { bsonType: 'string' },
    conversation_id: { bsonType: 'string' },
    role: { enum: [...MESSAGE_ROLES] },
    content: { bsonType: 'string' },
    provider: { bsonType: ['string', 'null'], enum: [...MESSAGE_PROVIDERS, null] },
    sources: { bsonType: 'array' },
    tool: { bsonType: ['object', 'null'] },
    feedback: { bsonType: ['object', 'null'] },
    created_at: { bsonType: 'string' },
  },
} as const;

const FAQ_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'title', 'answer', 'category'],
  properties: {
    _id: { bsonType: 'string' },
    title: { bsonType: 'string' },
    answer: { bsonType: 'string' },
    category: { enum: [...INTENTS] },
    tags: { bsonType: 'array', items: { bsonType: 'string' } },
    updated_at: { bsonType: 'string' },
  },
} as const;

const USER_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'email', 'name', 'role', 'password_hash', 'password_salt', 'created_at'],
  properties: {
    _id: { bsonType: 'string' },
    email: { bsonType: 'string' },
    name: { bsonType: 'string' },
    role: { enum: [...ROLES] },
    password_hash: { bsonType: 'string' },
    password_salt: { bsonType: 'string' },
    created_at: { bsonType: 'string' },
  },
} as const;

const SESSION_SCHEMA = {
  bsonType: 'object',
  required: ['_id', 'user_id', 'csrf_token', 'created_at', 'expires_at'],
  properties: {
    _id: { bsonType: 'string' },
    user_id: { bsonType: 'string' },
    csrf_token: { bsonType: 'string' },
    created_at: { bsonType: 'date' },
    expires_at: { bsonType: 'date' },
    last_seen_at: { bsonType: 'date' },
    user_agent: { bsonType: ['string', 'null'] },
  },
} as const;

async function setValidator(db: Db, name: string, schema: Record<string, unknown>): Promise<void> {
  const validator = { $jsonSchema: schema };
  const options = { validationLevel: 'moderate', validationAction: 'error' } as const;
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(name, { ...options, validator });
    return;
  }
  await db.command({ collMod: name, ...options, validator });
}

async function applyJsonSchemaValidators(db: Db): Promise<void> {
  const schemas: Array<[string, Record<string, unknown>]> = [
    ['conversations', CONVERSATION_SCHEMA],
    ['messages', MESSAGE_SCHEMA],
    ['faqs', FAQ_SCHEMA],
    ['users', USER_SCHEMA],
    ['sessions', SESSION_SCHEMA],
  ];
  for (const [name, schema] of schemas) {
    await setValidator(db, name, schema);
  }
}

const MIGRATIONS: Migration[] = [
  { id: '001-json-schema-validators', up: applyJsonSchemaValidators },
];

/** Applies any migrations not yet recorded. Idempotent and safe to re-run. */
export async function runMigrations(db: Db): Promise<void> {
  const applied = db.collection<MigrationDoc>('schema_migrations');
  const done = new Set((await applied.find().toArray()).map((doc) => doc._id));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue;
    await migration.up(db);
    await applied.insertOne({ _id: migration.id, applied_at: new Date().toISOString() });
    log.info('migration_applied', { id: migration.id });
  }
}
