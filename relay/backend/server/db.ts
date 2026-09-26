/**
 * Relay Store support backend - MongoDB persistence layer.
 *
 * Replaces the original node:sqlite implementation with the official
 * `mongodb` driver while preserving the same exported API, so the HTTP
 * layer (server/index.ts) and the integration tests are unchanged.
 *
 * Document model:
 *   conversations     - one doc per conversation; owner token hashes are
 *                       embedded so creation stays a single atomic insert.
 *                       Denormalized preview/humanHandled replace the old SQL
 *                       correlated subqueries.
 *   messages          - one doc per message; `sources` and `tool` are embedded.
 *   idempotency_keys  - TTL collection: entries expire after 24h (replaces the
 *                       manual DELETE sweep.
 *   faqs              - one doc per knowledge base article.
 *   rate_limits       - fixed-window abuse counters, TTL-cleaned (see
 *                       server/ratelimit.ts).
 *   turn_locks        - one doc per in-flight assistant turn, TTL = crash
 *                       recovery for abandoned locks.
 *
 * Multi-instance notes (production SaaS):
 *   - Rate limiting and per-conversation busy locks live in server/index.ts in
 *     memory. Horizontal scaling should move them to Redis or a Mongo-backed
 *     limiter; the data layer itself is stateless and safe to scale.
 */

import './env.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MongoClient, type Collection, type Db, type WithId } from 'mongodb';

import { type Intent } from './knowledge.js';
import { runMigrations } from './migrations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (the folder that contains `server/`). */
export const PROJECT_ROOT = (() => {
  const root = path.resolve(__dirname, '..');
  // Compiled production layout is dist/server/*.js, so the root is one level
  // higher there (dist/) than in the tsx/dev layout (server/).
  return path.basename(root) === 'dist' ? path.resolve(root, '..') : root;
})();

export const IS_LIVE = process.env.CODEBUDDY_LIVE === 'true';

function resolveDataDir(): string {
  const configured = process.env.DATA_DIR;
  if (configured && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(PROJECT_ROOT, 'data');
}

export const DATA_DIR = resolveDataDir();

// Legacy local-artifact folder — MongoDB persistence needs none of it. Best
// effort only, so a read-only filesystem (serverless deploys) cannot crash
// module loading.
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* read-only or unavailable: nothing in the app writes here */
  }
}

/**
 * Connection configuration.
 *   MONGODB_URI  - connection string; defaults to the local development server.
 *   MONGODB_DB   - database name
 */
const MONGODB_URI = (process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017').trim();
export const DB_NAME = (process.env.MONGODB_DB ?? 'relay_live').trim();

let client: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;
let database: Db | null = null;

export async function connectToDatabase(): Promise<Db> {
  if (database) return database;
  try {
    connectPromise ??= (async () => {
      const defaultPoolSize = process.env.VERCEL ? 10 : 20;
      const configuredPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE);
      const maxPoolSize =
        Number.isFinite(configuredPoolSize) && configuredPoolSize > 0 ? configuredPoolSize : defaultPoolSize;

      const created =
        client ??
        new MongoClient(MONGODB_URI, {
          serverSelectionTimeoutMS: 10_000,
          maxPoolSize,
        });
      await created.connect();
      client = created;
      return created;
    })().catch((err) => {
      connectPromise = null;
      client = null;
      database = null;
      throw err;
    });

    const connected = await connectPromise;
    database = connected.db(DB_NAME);
    await ensureIndexes(database);
    await runMigrations(database);
    return database;
  } catch (error) {
    connectPromise = null;
    client = null;
    database = null;
    throw error;
  }
}

/** Measures database latency; never throws. */
export async function pingDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  if (!database) return { ok: false, latencyMs: 0 };
  const start = process.hrtime.bigint();
  try {
    await database.command({ ping: 1 });
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    return { ok: true, latencyMs: Math.round(latencyMs * 10) / 10 };
  } catch {
    return { ok: false, latencyMs: 0 };
  }
}

/** For tests and graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    connectPromise = null;
    database = null;
  }
}

/**
 * The connected database handle. Throws if called before connectToDatabase()
 * has resolved — server startup guarantees that ordering.
 */
export function getDb(): Db {
  if (!database) throw new Error('Database not connected yet');
  return database;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db
      .collection('conversations')
      .createIndexes([{ key: { created_at: -1 } }, { key: { status: 1, updated_at: -1 } }]),
    db
      .collection('messages')
      .createIndexes([{ key: { conversation_id: 1, created_at: 1, _id: 1 } }, { key: { created_at: 1 } }]),
    db.collection('idempotency_keys').createIndexes([
      { key: { conversation_id: 1, client_id: 1 }, unique: true },
      // TTL: entries disappear automatically 24h after creation.
      { key: { created_at: 1 }, expireAfterSeconds: 24 * 60 * 60 },
    ]),
    db.collection('faqs').createIndexes([{ key: { category: 1, title: 1 } }]),
    db.collection('knowledge_gaps').createIndexes([{ key: { status: 1, created_at: -1 } }]),
  ]);
}

/* ------------------------------------------------------------------ *
 * Collections (lazily resolved after connectToDatabase)
 * ------------------------------------------------------------------ */

interface ConversationDoc {
  _id: string;
  customer: string;
  email: string;
  title: string;
  intent: Intent;
  status: 'open' | 'waiting' | 'resolved';
  assignee: string | null;
  rating: number | null;
  escalation_reason: string | null;
  low_confidence_streak: number;
  unresolved_streak: number;
  preview: string;
  human_handled: boolean;
  token_hashes: string[];
  created_at: string;
  updated_at: string;
}

export interface MessageFeedbackDoc {
  helpful: boolean;
  reason?: 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human' | null;
  comment?: string | null;
  created_at: string;
}

interface MessageDoc {
  _id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'human' | 'system';
  content: string;
  provider: string | null;
  sources: SourceRef[];
  tool: ToolEventRecord | null;
  feedback?: MessageFeedbackDoc | null;
  created_at: string;
}

interface IdempotencyDoc {
  _id: string;
  conversation_id: string;
  client_id: string;
  created_at: Date;
}

interface FaqDoc {
  _id: string;
  title: string;
  answer: string;
  category: Intent;
  tags: string[];
  updated_at: string;
}

export interface KnowledgeGapDoc {
  _id: string;
  conversation_id: string;
  message_id: string;
  query: string;
  answer?: string;
  comment?: string | null;
  reason: string;
  sources_used: SourceRef[];
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at?: string | null;
}

function conversations(): Collection<ConversationDoc> {
  return database!.collection<ConversationDoc>('conversations');
}
function messages(): Collection<MessageDoc> {
  return database!.collection<MessageDoc>('messages');
}
function idempotencyKeys(): Collection<IdempotencyDoc> {
  return database!.collection<IdempotencyDoc>('idempotency_keys');
}
function faqsCollection(): Collection<FaqDoc> {
  return database!.collection<FaqDoc>('faqs');
}
function knowledgeGaps(): Collection<KnowledgeGapDoc> {
  return database!.collection<KnowledgeGapDoc>('knowledge_gaps');
}

/* ------------------------------------------------------------------ *
 * Public types (mirrors the API contract)
 * ------------------------------------------------------------------ */

export type ConversationStatus = 'open' | 'waiting' | 'resolved';
export type MessageRole = 'user' | 'assistant' | 'human' | 'system';
export type MessageProvider = 'codebuddy' | 'human';
export type SourceRef = { id: string; title: string };

export interface Conversation {
  id: string;
  customer: string;
  email: string;
  title: string;
  intent: Intent;
  status: ConversationStatus;
  assignee: string | null;
  rating: number | null;
  createdAt: string;
  updatedAt: string;
  preview: string;
  escalationReason: string | null;
}

export interface MessageFeedback {
  helpful: boolean;
  reason?: 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human' | null;
  comment?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  sources: SourceRef[];
  /** Scripted tool call performed during this turn, if any. */
  tool?: ToolEventRecord | null;
  provider?: MessageProvider;
  feedback?: MessageFeedback | null;
}

export interface KnowledgeGap {
  id: string;
  conversationId: string;
  messageId: string;
  query: string;
  answer?: string;
  comment?: string | null;
  reason: string;
  sourcesUsed: SourceRef[];
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string | null;
}

export interface Faq {
  id: string;
  title: string;
  answer: string;
  category: Intent;
  tags: string[];
  updatedAt: string;
}

export interface ToolEventRecord {
  name: 'lookup_order';
  args: { orderId: string };
}

/**
 * Row-like view of a conversation used by the turn pipeline in server/index.ts
 * (kept shape-compatible with the previous SQLite row object).
 */
export interface ConversationRow {
  id: string;
  status: ConversationStatus;
  intent: Intent;
  low_confidence_streak: number;
  unresolved_streak: number;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Runs a callback inside a transaction when the deployment supports it. */
async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (!client) throw new Error('Database not connected');
  try {
    const session = client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn();
      });
      return result;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    // Standalone mongod (no replica set) cannot run transactions; the write
    // paths below are idempotent or single-document, so fall back gracefully.
    if (error instanceof Error && /trans(action|actions)/i.test(error.message)) {
      return fn();
    }
    throw error;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

function truncatePreview(content: string): string {
  const flat = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= 140) return flat;
  return `${flat.slice(0, 139)}\u2026`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

function mapConversation(doc: WithId<ConversationDoc>): Conversation {
  return {
    id: doc._id,
    customer: doc.customer,
    email: doc.email ?? '',
    title: doc.title,
    intent: doc.intent ?? 'general',
    status: doc.status ?? 'open',
    assignee: doc.assignee ?? null,
    rating: doc.rating === null || doc.rating === undefined ? null : Number(doc.rating),
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    preview: doc.preview ?? '',
    escalationReason: doc.escalation_reason ?? null,
  };
}

function mapMessage(doc: WithId<MessageDoc>): Message {
  const message: Message = {
    id: doc._id,
    conversationId: doc.conversation_id,
    role: doc.role,
    content: doc.content,
    createdAt: doc.created_at,
    sources: Array.isArray(doc.sources) ? doc.sources : [],
    tool: doc.tool ?? null,
  };
  if (doc.provider) message.provider = doc.provider as MessageProvider;
  if (doc.feedback) {
    message.feedback = {
      helpful: doc.feedback.helpful,
      reason: doc.feedback.reason ?? null,
      comment: doc.feedback.comment ?? null,
    };
  }
  return message;
}

function mapFaq(doc: WithId<FaqDoc>): Faq {
  return {
    id: doc._id,
    title: doc.title,
    answer: doc.answer,
    category: doc.category ?? 'general',
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    updatedAt: doc.updated_at,
  };
}

function toRow(doc: WithId<ConversationDoc>): ConversationRow {
  return {
    id: doc._id,
    status: doc.status,
    intent: doc.intent,
    low_confidence_streak: Number(doc.low_confidence_streak ?? 0),
    unresolved_streak: Number(doc.unresolved_streak ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

export interface ListConversationsOptions {
  limit?: number;
  offset?: number;
}

/** Newest-first page of conversations plus the total count for pagination UI. */
export async function listConversations(
  options: ListConversationsOptions = {},
): Promise<{ items: Conversation[]; total: number }> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 200));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const [docs, total] = await Promise.all([
    conversations().find().sort({ updated_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
    conversations().countDocuments(),
  ]);
  return { items: docs.map(mapConversation), total };
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const doc = await conversations().findOne({ _id: id });
  return doc ? mapConversation(doc) : null;
}

export async function getConversationRow(id: string): Promise<ConversationRow | null> {
  const doc = await conversations().findOne({ _id: id });
  return doc ? toRow(doc) : null;
}

export interface CreateConversationInput {
  customer?: string;
  email?: string;
}

export interface CreatedConversation {
  conversation: Conversation;
  accessToken: string;
}

export async function createConversation(input: CreateConversationInput = {}): Promise<CreatedConversation> {
  const id = newId();
  const createdAt = nowIso();
  const customer = (input.customer ?? '').trim() || 'Guest';
  const email = (input.email ?? '').trim();
  const accessToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(accessToken);

  const doc: ConversationDoc = {
    _id: id,
    customer,
    email,
    title: 'New conversation',
    intent: 'general',
    status: 'open',
    assignee: null,
    rating: null,
    escalation_reason: null,
    low_confidence_streak: 0,
    unresolved_streak: 0,
    preview: '',
    human_handled: false,
    token_hashes: [tokenHash],
    created_at: createdAt,
    updated_at: createdAt,
  };

  await withTransaction(async () => {
    await conversations().insertOne(doc);
  });

  const conversation = await getConversation(id);
  if (!conversation) throw new Error('Failed to create conversation');
  return { conversation, accessToken };
}

export interface ConversationPatch {
  title?: string;
  intent?: Intent;
  status?: ConversationStatus;
  assignee?: string | null;
  rating?: number | null;
  escalationReason?: string | null;
  lowConfidenceStreak?: number;
  unresolvedStreak?: number;
}

export async function updateConversation(id: string, patch: ConversationPatch): Promise<Conversation | null> {
  const set: Partial<ConversationDoc> = {};
  const unset: Partial<Record<keyof ConversationDoc, 1>> = {};

  if (patch.title !== undefined) set.title = patch.title;
  if (patch.intent !== undefined) set.intent = patch.intent;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.escalationReason !== undefined) set.escalation_reason = patch.escalationReason;
  if (patch.lowConfidenceStreak !== undefined) set.low_confidence_streak = patch.lowConfidenceStreak;
  if (patch.unresolvedStreak !== undefined) set.unresolved_streak = patch.unresolvedStreak;
  if (patch.rating !== undefined) set.rating = patch.rating;
  if (patch.assignee !== undefined) {
    if (patch.assignee === null) unset.assignee = 1;
    else set.assignee = patch.assignee;
  }

  set.updated_at = nowIso();
  const update: Record<string, unknown> = { $set: set };
  if (Object.keys(unset).length > 0) update.$unset = unset;

  await conversations().updateOne({ _id: id }, update);
  return getConversation(id);
}

/** Constant-time verification of a customer access token. */
export async function verifyConversationToken(conversationId: string, token: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const doc = await conversations().findOne(
    { _id: conversationId, token_hashes: tokenHash },
    { projection: { _id: 1 } },
  );
  return doc !== null;
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export interface AddMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  provider?: MessageProvider | null;
  sources?: SourceRef[];
  /** Scripted tool call performed during this turn, persisted for the UI. */
  tool?: ToolEventRecord | null;
  createdAt?: string;
  id?: string;
  /** When true the conversation `updated_at` is not touched (used by seeding). */
  skipTouch?: boolean;
}

export async function addMessage(input: AddMessageInput): Promise<Message> {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? nowIso();
  const sources = input.sources ?? [];

  const doc: MessageDoc = {
    _id: id,
    conversation_id: input.conversationId,
    role: input.role,
    content: input.content,
    provider: input.provider ?? null,
    sources,
    tool: input.tool ?? null,
    created_at: createdAt,
  };

  const touch: Partial<ConversationDoc> = { updated_at: createdAt };
  if (input.role === 'human') touch.human_handled = true;
  if (!input.skipTouch && (input.role === 'user' || input.role === 'assistant' || input.role === 'human')) {
    touch.preview = truncatePreview(input.content);
  }

  await messages().insertOne(doc);
  if (!input.skipTouch) {
    await conversations().updateOne({ _id: input.conversationId }, { $set: touch });
  }

  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    createdAt,
    sources,
    ...(input.tool ? { tool: input.tool } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
  };
}

export async function getMessages(
  conversationId: string,
  options: { limit?: number } = {},
): Promise<Message[]> {
  // PRD-009: transcripts are bounded — read newest-first, cap, then restore
  // chronological order. The default cap (500) is a safety net; HTTP routes
  // pass a smaller page (200) via ?limit=. Internal history builders that
  // need more pass an explicit limit.
  const limit = options.limit === undefined ? 500 : Math.max(1, Math.min(Math.floor(options.limit), 1000));
  const docs = await messages()
    .find({ conversation_id: conversationId })
    .sort({ created_at: -1, _id: -1 })
    .limit(limit)
    .toArray();
  docs.reverse();
  return docs.map(mapMessage);
}

export async function recordMessageFeedback(
  conversationId: string,
  messageId: string,
  feedback: {
    helpful: boolean;
    reason?: 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human' | null;
    comment?: string | null;
  },
): Promise<Message | null> {
  const createdAt = nowIso();
  const feedbackDoc: MessageFeedbackDoc = {
    helpful: feedback.helpful,
    reason: feedback.reason ?? null,
    comment: feedback.comment ?? null,
    created_at: createdAt,
  };

  await messages().updateOne(
    { _id: messageId, conversation_id: conversationId },
    { $set: { feedback: feedbackDoc } },
  );

  const updated = await messages().findOne({ _id: messageId, conversation_id: conversationId });
  if (!updated) return null;

  if (!feedback.helpful) {
    const priorUser = await messages().findOne(
      { conversation_id: conversationId, role: 'user', created_at: { $lte: updated.created_at } },
      { sort: { created_at: -1 } },
    );
    await knowledgeGaps().insertOne({
      _id: newId(),
      conversation_id: conversationId,
      message_id: messageId,
      query: priorUser?.content ?? 'Customer question',
      answer: updated.content,
      comment: feedback.comment ?? null,
      reason: feedback.reason ?? 'unhelpful_answer',
      sources_used: updated.sources ?? [],
      status: 'open',
      created_at: createdAt,
    });
  }

  return mapMessage(updated);
}

export async function listKnowledgeGaps(
  options: { limit?: number; offset?: number } = {},
): Promise<KnowledgeGap[]> {
  // PRD-009: previously a hardcoded limit(100) with no paging; now bounded
  // (default 100, max 200) with an offset.
  const limit = options.limit === undefined ? 100 : Math.max(1, Math.min(Math.floor(options.limit), 200));
  const offset = options.offset === undefined ? 0 : Math.max(0, Math.floor(options.offset));
  const docs = await knowledgeGaps().find().sort({ created_at: -1 }).skip(offset).limit(limit).toArray();
  return docs.map((doc) => ({
    id: doc._id,
    conversationId: doc.conversation_id,
    messageId: doc.message_id,
    query: doc.query,
    answer: doc.answer,
    comment: doc.comment ?? null,
    reason: doc.reason,
    sourcesUsed: doc.sources_used ?? [],
    status: doc.status,
    createdAt: doc.created_at,
    resolvedAt: doc.resolved_at ?? null,
  }));
}

export async function resolveKnowledgeGap(id: string): Promise<boolean> {
  const result = await knowledgeGaps().updateOne(
    { _id: id },
    { $set: { status: 'resolved', resolved_at: nowIso() } },
  );
  return result.matchedCount > 0;
}

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

export async function hasIdempotencyKey(conversationId: string, clientId: string): Promise<boolean> {
  const doc = await idempotencyKeys().findOne({ conversation_id: conversationId, client_id: clientId });
  return doc !== null;
}

export async function recordIdempotencyKey(conversationId: string, clientId: string): Promise<void> {
  await idempotencyKeys().updateOne(
    { conversation_id: conversationId, client_id: clientId },
    { $setOnInsert: { _id: newId(), created_at: new Date() } },
    { upsert: true },
  );
}

/* ------------------------------------------------------------------ *
 * FAQs
 * ------------------------------------------------------------------ */

export async function countFaqs(): Promise<number> {
  return faqsCollection().countDocuments();
}

export async function listFaqs(options: { limit?: number; offset?: number } = {}): Promise<Faq[]> {
  // PRD-009: previously unbounded. Internal consumers (agent retrieval) pass
  // no options and keep full-list behaviour; HTTP routes pass a bounded page.
  const cursor = faqsCollection().find().sort({ category: 1, title: 1 });
  if (options.offset !== undefined) cursor.skip(Math.max(0, Math.floor(options.offset)));
  if (options.limit !== undefined) cursor.limit(Math.max(1, Math.min(Math.floor(options.limit), 500)));
  const docs = await cursor.toArray();
  return docs.map(mapFaq);
}

export async function getFaq(id: string): Promise<Faq | null> {
  const doc = await faqsCollection().findOne({ _id: id });
  return doc ? mapFaq(doc) : null;
}

export interface FaqInput {
  title: string;
  answer: string;
  category: Intent;
  tags: string[];
}

export async function createFaq(input: FaqInput): Promise<Faq> {
  const id = newId();
  const updatedAt = nowIso();
  await faqsCollection().insertOne({
    _id: id,
    title: input.title,
    answer: input.answer,
    category: input.category,
    tags: input.tags,
    updated_at: updatedAt,
  });
  const faq = await getFaq(id);
  if (!faq) throw new Error('Failed to create FAQ');
  return faq;
}

export async function updateFaq(id: string, patch: Partial<FaqInput>): Promise<Faq | null> {
  const set: Partial<FaqDoc> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.answer !== undefined) set.answer = patch.answer;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.tags !== undefined) set.tags = patch.tags;

  if (Object.keys(set).length === 0) return getFaq(id);

  set.updated_at = nowIso();
  const result = await faqsCollection().updateOne({ _id: id }, { $set: set });
  if (result.matchedCount === 0) return null;
  return getFaq(id);
}

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

export interface StatsVolumePoint {
  date: string;
  label: string;
  ai: number;
  human: number;
}

export interface StatsResult {
  total: number;
  resolved: number;
  aiResolutions: number;
  humanHandoffs: number;
  resolutionRate: number;
  csat: number | null;
  avgResponseSeconds: number | null;
  waiting: number;
  ratingCount: number;
  volume: StatsVolumePoint[];
  intents: Array<{ intent: Intent; count: number }>;
  satisfaction: Array<{ score: number; count: number }>;
}

/** Conversations created since the given instant (free-plan metering). */
export async function countConversationsSince(windowStart: Date): Promise<number> {
  return conversations().countDocuments({ created_at: { $gte: windowStart.toISOString() } });
}

/** Assistant replies generated since the given instant (free-plan metering). */
export async function countAssistantMessagesSince(windowStart: Date): Promise<number> {
  return messages().countDocuments({ role: 'assistant', created_at: { $gte: windowStart.toISOString() } });
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export async function getStats(days: number): Promise<StatsResult> {
  const safeDays = days === 30 ? 30 : 7;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (safeDays - 1), 0, 0, 0, 0);
  const windowStart = start.toISOString();
  const windowEnd = now.toISOString();

  const conversationDocs = await conversations()
    .find(
      { created_at: { $gte: windowStart, $lte: windowEnd } },
      { projection: { intent: 1, status: 1, rating: 1, created_at: 1, human_handled: 1 } },
    )
    .toArray();

  const total = conversationDocs.length;
  const resolvedCount = conversationDocs.filter((doc) => doc.status === 'resolved').length;
  const waiting = conversationDocs.filter((doc) => doc.status === 'waiting').length;

  const rated = conversationDocs.filter((doc) => doc.rating !== null && doc.rating !== undefined);
  const ratingCount = rated.length;
  const positiveRatings = rated.filter((doc) => Number(doc.rating) >= 4).length;

  const resolutionRate = total > 0 ? round((resolvedCount / total) * 100, 1) : 0;
  const csat = ratingCount > 0 ? round((positiveRatings / ratingCount) * 100, 1) : null;

  // First response time + volume come from the messages inside the window.
  const messageDocs = await messages()
    .find(
      { created_at: { $gte: windowStart } },
      { projection: { conversation_id: 1, role: 1, created_at: 1 } },
    )
    .sort({ conversation_id: 1, created_at: 1, _id: 1 })
    .toArray();

  const buckets = new Map<string, StatsVolumePoint>();
  for (let i = 0; i < safeDays; i += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    buckets.set(localDayKey(day), { date: localDayKey(day), label: dayLabel(day), ai: 0, human: 0 });
  }

  // Each conversation is counted exactly once, on its creation day.
  for (const conversation of conversationDocs) {
    const bucket = buckets.get(localDayKey(new Date(conversation.created_at)));
    if (!bucket) continue;
    if (conversation.human_handled || conversation.status === 'waiting') bucket.human += 1;
    else bucket.ai += 1;
  }

  // First response per conversation; system notices are not support replies.
  const responded = new Set<string>();
  let pending: { conversationId: string; at: number } | null = null;
  let responseTotal = 0;
  let responseCount = 0;
  for (const message of messageDocs) {
    if (message.role === 'system') continue;
    const at = new Date(message.created_at).getTime();
    if (message.role === 'user') {
      if (!pending || pending.conversationId !== message.conversation_id) {
        pending = { conversationId: message.conversation_id, at };
      }
      continue;
    }
    if (responded.has(message.conversation_id)) continue;
    if (pending && pending.conversationId === message.conversation_id) {
      const seconds = (at - pending.at) / 1000;
      if (seconds >= 0 && seconds < 60 * 60 * 24) {
        responseTotal += seconds;
        responseCount += 1;
      }
      responded.add(message.conversation_id);
      pending = null;
    }
  }

  const avgResponseSeconds = responseCount > 0 ? round(responseTotal / responseCount, 1) : null;

  const intentCounts = new Map<Intent, number>();
  for (const intent of ['refund', 'order', 'technical', 'general'] as Intent[]) {
    intentCounts.set(intent, 0);
  }
  for (const doc of conversationDocs) {
    const intent = doc.intent ?? 'general';
    intentCounts.set(intent, (intentCounts.get(intent) ?? 0) + 1);
  }
  const intents: Array<{ intent: Intent; count: number }> = [];
  intentCounts.forEach((count, intent) => intents.push({ intent, count }));
  intents.sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent));

  const scoreCounts = new Map<number, number>();
  for (let score = 1; score <= 5; score += 1) scoreCounts.set(score, 0);
  for (const doc of rated) {
    const score = Number(doc.rating);
    if (score >= 1 && score <= 5) scoreCounts.set(score, (scoreCounts.get(score) ?? 0) + 1);
  }
  const satisfaction: Array<{ score: number; count: number }> = [];
  scoreCounts.forEach((count, score) => satisfaction.push({ score, count }));
  satisfaction.sort((a, b) => a.score - b.score);

  const volume: StatsVolumePoint[] = [];
  buckets.forEach((point) => volume.push(point));

  const humanHandoffs = conversationDocs.filter(
    (doc) => doc.human_handled || doc.status === 'waiting',
  ).length;
  const aiResolutions = Math.max(0, total - humanHandoffs);

  return {
    total,
    resolved: resolvedCount,
    aiResolutions,
    humanHandoffs,
    resolutionRate,
    csat,
    avgResponseSeconds,
    waiting,
    ratingCount,
    volume,
    intents,
    satisfaction,
  };
}
