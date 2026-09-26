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
 *                       manual DELETE sweep).
 *   faqs              - one doc per knowledge base article.
 *   meta              - key/value markers (demo seeding).
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

import { SEED_FAQS, type FaqRecord, type Intent } from './knowledge.js';
import { findOrderById, orderStatusSentence } from './orders.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root (the folder that contains `server/`). */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

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
 *   MONGODB_DB   - database name; demo and live modes use separate databases so
 *                  live conversations never mix with demo records.
 */
const MONGODB_URI = (process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017').trim();
export const DB_NAME = (process.env.MONGODB_DB ?? (IS_LIVE ? 'relay_live' : 'relay')).trim();

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
        Number.isFinite(configuredPoolSize) && configuredPoolSize > 0
          ? configuredPoolSize
          : defaultPoolSize;

      const created = client ?? new MongoClient(MONGODB_URI, {
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
    db.collection('conversations').createIndexes([
      { key: { created_at: -1 } },
      { key: { status: 1, updated_at: -1 } },
    ]),
    db.collection('messages').createIndexes([
      { key: { conversation_id: 1, created_at: 1, _id: 1 } },
      { key: { created_at: 1 } },
    ]),
    db.collection('idempotency_keys').createIndexes([
      { key: { conversation_id: 1, client_id: 1 }, unique: true },
      // TTL: entries disappear automatically 24h after creation.
      { key: { created_at: 1 }, expireAfterSeconds: 24 * 60 * 60 },
    ]),
    db.collection('faqs').createIndexes([
      { key: { category: 1, title: 1 } },
    ]),
    db.collection('knowledge_gaps').createIndexes([
      { key: { status: 1, created_at: -1 } },
    ]),
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
  is_demo: boolean;
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

interface MetaDoc {
  _id: string;
  value: string;
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
function meta(): Collection<MetaDoc> {
  return database!.collection<MetaDoc>('meta');
}

/* ------------------------------------------------------------------ *
 * Public types (mirrors the API contract)
 * ------------------------------------------------------------------ */

export type ConversationStatus = 'open' | 'waiting' | 'resolved';
export type MessageRole = 'user' | 'assistant' | 'human' | 'system';
export type MessageProvider = 'demo' | 'codebuddy' | 'human';
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
  isDemo: boolean;
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
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim();
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
    isDemo: doc.is_demo === true,
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
    conversations()
      .find()
      .sort({ updated_at: -1, _id: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
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
  isDemo?: boolean;
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
    is_demo: input.isDemo === true,
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

export async function getMessages(conversationId: string): Promise<Message[]> {
  const docs = await messages()
    .find({ conversation_id: conversationId })
    .sort({ created_at: 1, _id: 1 })
    .toArray();
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

export async function listKnowledgeGaps(): Promise<KnowledgeGap[]> {
  const docs = await knowledgeGaps().find().sort({ created_at: -1 }).limit(100).toArray();
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

export async function seedSampleKnowledge(): Promise<Faq[]> {
  const existing = await faqsCollection().find().toArray();
  const existingIds = new Set(existing.map((f) => f._id));
  const toInsert: FaqDoc[] = [];

  for (const faq of SEED_FAQS) {
    if (!existingIds.has(faq.id)) {
      toInsert.push({
        _id: faq.id,
        title: faq.title,
        answer: faq.answer,
        category: faq.category,
        tags: faq.tags,
        updated_at: nowIso(),
      });
    }
  }

  if (toInsert.length > 0) {
    await faqsCollection().insertMany(toInsert);
  }

  return listFaqs();
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

export async function listFaqs(): Promise<Faq[]> {
  const docs = await faqsCollection().find().sort({ category: 1, title: 1 }).toArray();
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

/* ------------------------------------------------------------------ *
 * Demo seed data
 * ------------------------------------------------------------------ */

interface SeedTurn {
  role: 'user' | 'assistant' | 'human' | 'system';
  content: string;
  provider?: 'demo' | 'human';
  sources?: SourceRef[];
  tool?: ToolEventRecord | null;
}

interface SeedScenario {
  intent: Intent;
  title: string;
  status: ConversationStatus;
  escalationReason?: string;
  assignee?: string;
  rating?: number;
  turns: SeedTurn[];
}

function faqSource(id: string): SourceRef[] {
  const faq = SEED_FAQS.find((entry) => entry.id === id);
  return faq ? [{ id: faq.id, title: faq.title }] : [];
}

const FAQ_ANSWER = (id: string): string => SEED_FAQS.find((entry) => entry.id === id)?.answer ?? '';

const HANDOFF_REFUND_STATUS =
  "Refund status is tied to your specific order and payment provider, and I can't read it from here. I've handed this conversation to a human agent who can check it with the payments team - nothing was lost, your message and the full history go with it.";

const HANDOFF_ORDER_LOOKUP =
  "This prototype has no live order or carrier integration, so I can't read your order's status. I've passed this to a human agent who can look the order up for you.";

const HANDOFF_CANCEL =
  "Cancelling depends on the live state of your order, which I can't read or change from here. I've passed this to a human agent who can action it - your message is saved, so you don't need to repeat it.";

const HANDOFF_ACCOUNT =
  "Account changes need identity verification, which I can't do in this chat. I've handed this to a human agent who will verify you first. We'll never ask for your password.";

const HANDOFF_HUMAN =
  "Of course - I'm passing this conversation to a human agent now. You don't need to repeat anything, the full history goes with it. Support is staffed Monday to Friday, 9am to 6pm.";

const HANDOFF_BILLING =
  "I can't look at or change billing from here, so I've handed this to a human agent who can check it with the payments team.";

const HANDOFF_REPEATED =
  "I haven't been able to resolve this from the knowledge base, so I've handed the conversation to a human agent rather than guess. Everything you've sent is saved.";

const CLARIFY_TECHNICAL =
  "I want to point you at the right fix rather than guess. Are you having trouble signing in, seeing an error on a page, or something not updating on the site?";

const SEED_SCENARIOS: SeedScenario[] = [
  {
    intent: 'refund',
    title: 'Return request: Studio headphones',
    status: 'resolved',
    assignee: 'Priya Nair',
    rating: 5,
    turns: [
      { role: 'user', content: "Hi, I'd like to return a pair of Studio headphones I ordered last week.", provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-return-policy-30-days'), provider: 'demo', sources: faqSource('faq-return-policy-30-days') },
      { role: 'user', content: "Got it, I'll start the return from my account. Thanks!", provider: 'demo' },
      { role: 'assistant', content: 'Happy to help. If the return label gives you any trouble, ask for a human agent and we will pick it up from there.', provider: 'demo' },
    ],
  },
  {
    intent: 'refund',
    title: 'How long refunds take',
    status: 'resolved',
    rating: 5,
    turns: [
      { role: 'user', content: 'How long do refunds normally take once they are approved?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-refund-timing'), provider: 'demo', sources: faqSource('faq-refund-timing') },
      { role: 'user', content: 'Perfect, thanks.', provider: 'demo' },
    ],
  },
  {
    intent: 'refund',
    title: 'No refund after two weeks',
    status: 'waiting',
    escalationReason: 'Refund status is account specific and needs a human agent',
    turns: [
      { role: 'user', content: 'I sent my return back two weeks ago and I still have no refund.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_REFUND_STATUS, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Refund status is account specific and needs a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'refund',
    title: 'Asking for an immediate refund',
    status: 'open',
    turns: [
      { role: 'user', content: 'Can you refund me right now? I changed my mind about the order.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-no-refunds-performed'), provider: 'demo', sources: faqSource('faq-no-refunds-performed') },
    ],
  },
  {
    intent: 'refund',
    title: 'Damaged jacket on arrival',
    status: 'resolved',
    assignee: 'Alex Morgan',
    turns: [
      { role: 'user', content: 'The jacket I received has a torn seam, can I get my money back?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-return-policy-30-days'), provider: 'demo', sources: faqSource('faq-return-policy-30-days') },
      { role: 'user', content: 'Ok, starting the return now.', provider: 'demo' },
      { role: 'human', content: "Thanks for waiting - I've added a note to your return so the team doesn't decline it for condition.", provider: 'human' },
    ],
  },
  {
    intent: 'refund',
    title: 'Refund not received after three weeks',
    status: 'waiting',
    escalationReason: 'Refund status is account specific and needs a human agent',
    turns: [
      { role: 'user', content: "Where is my refund? It's been almost three weeks.", provider: 'demo' },
      { role: 'assistant', content: HANDOFF_REFUND_STATUS, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Refund status is account specific and needs a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'refund',
    title: 'Return window start date',
    status: 'open',
    turns: [
      { role: 'user', content: 'Is the 30 day return window counted from the order date or the delivery date?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-return-policy-30-days'), provider: 'demo', sources: faqSource('faq-return-policy-30-days') },
    ],
  },
  {
    intent: 'refund',
    title: 'Two charges for one order',
    status: 'waiting',
    escalationReason: 'Billing dispute needs a human agent',
    turns: [
      { role: 'user', content: 'There are two charges on my card for a single order.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_BILLING, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Billing dispute needs a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Where is my order',
    status: 'waiting',
    escalationReason: 'Order lookup needs live order access which this channel does not have',
    turns: [
      { role: 'user', content: 'Where is my order? It was supposed to arrive on Tuesday.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_ORDER_LOOKUP, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Order lookup needs live order access which this channel does not have', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'How do I track my order',
    status: 'resolved',
    assignee: 'Alex Morgan',
    rating: 5,
    turns: [
      { role: 'user', content: 'How do I track my order?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-order-tracking'), provider: 'demo', sources: faqSource('faq-order-tracking') },
      { role: 'user', content: 'Thanks, I found the email.', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Order #4471 status lookup',
    status: 'open',
    turns: [
      { role: 'user', content: "Where's my order #4471? It was supposed to arrive today.", provider: 'demo' },
      {
        role: 'assistant',
        provider: 'demo',
        content: orderStatusSentence(findOrderById('4471')!)
          + ' It was loaded onto the delivery van this morning and should arrive today before 8 pm.',
        tool: { name: 'lookup_order', args: { orderId: '4471' } },
      },
      { role: 'user', content: 'Perfect, thanks for checking!', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Parcel never showed up',
    status: 'open',
    turns: [
      { role: 'user', content: 'My parcel never showed up.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-failed-delivery'), provider: 'demo', sources: faqSource('faq-failed-delivery') },
    ],
  },
  {
    intent: 'order',
    title: 'Cancel before shipping',
    status: 'waiting',
    escalationReason: 'Order cancellation depends on live order state and needs a human agent',
    turns: [
      { role: 'user', content: 'I need to cancel my order before it ships.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_CANCEL, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Order cancellation depends on live order state and needs a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Failed delivery attempt',
    status: 'resolved',
    rating: 4,
    turns: [
      { role: 'user', content: 'The carrier said the delivery attempt failed. What happens now?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-failed-delivery'), provider: 'demo', sources: faqSource('faq-failed-delivery') },
      { role: 'user', content: "Great, I'll wait for the reattempt.", provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Tracking has not moved',
    status: 'waiting',
    escalationReason: 'Order lookup needs live order access which this channel does not have',
    turns: [
      { role: 'user', content: "Can you check my order? The tracking hasn't moved in four days.", provider: 'demo' },
      { role: 'assistant', content: HANDOFF_ORDER_LOOKUP, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Order lookup needs live order access which this channel does not have', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Update delivery address',
    status: 'waiting',
    escalationReason: 'Account changes require identity verification by a human agent',
    turns: [
      { role: 'user', content: 'How do I update the delivery address on an order I just placed?', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_ACCOUNT, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Account changes require identity verification by a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'order',
    title: 'Meaning of failed delivery status',
    status: 'open',
    turns: [
      { role: 'user', content: "What does 'delivery attempt failed' mean on my tracking?", provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-failed-delivery'), provider: 'demo', sources: faqSource('faq-failed-delivery') },
    ],
  },
  {
    intent: 'technical',
    title: 'Cannot log in',
    status: 'resolved',
    assignee: 'Priya Nair',
    rating: 5,
    turns: [
      { role: 'user', content: "I can't log in, it says my password is incorrect.", provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-login-password'), provider: 'demo', sources: faqSource('faq-login-password') },
      { role: 'user', content: "The reset link worked, I'm in. Thanks!", provider: 'demo' },
    ],
  },
  {
    intent: 'technical',
    title: 'Error at checkout',
    status: 'open',
    turns: [
      { role: 'user', content: 'The site keeps showing an error when I try to check out.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-error-message'), provider: 'demo', sources: faqSource('faq-error-message') },
    ],
  },
  {
    intent: 'technical',
    title: 'Cart empties on reload',
    status: 'resolved',
    assignee: 'Alex Morgan',
    rating: 3,
    turns: [
      { role: 'user', content: 'My cart empties every time I reload the page.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-browser-cache'), provider: 'demo', sources: faqSource('faq-browser-cache') },
      { role: 'user', content: 'Clearing the cache fixed it.', provider: 'demo' },
      { role: 'human', content: 'Good to hear. If it comes back, the cart also depends on first-party cookies being allowed.', provider: 'human' },
    ],
  },
  {
    intent: 'technical',
    title: 'No verification email',
    status: 'open',
    turns: [
      { role: 'user', content: 'I never got the verification email for my new account.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-email-verification'), provider: 'demo', sources: faqSource('faq-email-verification') },
    ],
  },
  {
    intent: 'technical',
    title: 'Sign in still failing after cache clear',
    status: 'waiting',
    escalationReason: 'Two consecutive low confidence turns without resolution',
    turns: [
      { role: 'user', content: "I can't sign in to my account.", provider: 'demo' },
      { role: 'assistant', content: CLARIFY_TECHNICAL, provider: 'demo' },
      { role: 'user', content: 'It still does not work.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_REPEATED, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Two consecutive low confidence turns without resolution', provider: 'demo' },
    ],
  },
  {
    intent: 'technical',
    title: 'Blocked cookies sign me out',
    status: 'open',
    turns: [
      { role: 'user', content: 'Cookies are blocked on my work laptop, is that why the site signs me out?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-cookies'), provider: 'demo', sources: faqSource('faq-cookies') },
    ],
  },
  {
    intent: 'technical',
    title: 'Error 500 on returns page',
    status: 'resolved',
    rating: 5,
    turns: [
      { role: 'user', content: 'I get error 500 when I open the returns page.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-error-message'), provider: 'demo', sources: faqSource('faq-error-message') },
      { role: 'user', content: 'Sent the screenshot, thanks.', provider: 'demo' },
    ],
  },
  {
    intent: 'technical',
    title: 'Reset link expired',
    status: 'open',
    turns: [
      { role: 'user', content: 'My password reset link says it expired.', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-login-password'), provider: 'demo', sources: faqSource('faq-login-password') },
    ],
  },
  {
    intent: 'general',
    title: 'Wants a human agent',
    status: 'waiting',
    escalationReason: 'Customer asked to speak with a human agent',
    turns: [
      { role: 'user', content: 'Can I talk to a real person please?', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_HUMAN, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Customer asked to speak with a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'general',
    title: 'Payments over chat',
    status: 'resolved',
    rating: 4,
    turns: [
      { role: 'user', content: 'Do you take card payments over chat?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-payment-actions'), provider: 'demo', sources: faqSource('faq-payment-actions') },
      { role: 'user', content: 'Understood.', provider: 'demo' },
    ],
  },
  {
    intent: 'general',
    title: 'Change account email',
    status: 'waiting',
    escalationReason: 'Account changes require identity verification by a human agent',
    turns: [
      { role: 'user', content: 'I want to change the email address on my account.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_ACCOUNT, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Account changes require identity verification by a human agent', provider: 'demo' },
    ],
  },
  {
    intent: 'general',
    title: 'Support hours',
    status: 'open',
    turns: [
      { role: 'user', content: 'What are your support hours?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-human-agent'), provider: 'demo', sources: faqSource('faq-human-agent') },
    ],
  },
  {
    intent: 'general',
    title: 'Phone number request',
    status: 'resolved',
    assignee: 'Priya Nair',
    rating: 5,
    turns: [
      { role: 'user', content: 'Is there a phone number I can call?', provider: 'demo' },
      { role: 'assistant', content: FAQ_ANSWER('faq-human-agent'), provider: 'demo', sources: faqSource('faq-human-agent') },
      { role: 'user', content: 'Fine, I will use this chat then.', provider: 'demo' },
    ],
  },
  {
    intent: 'general',
    title: 'Delete my account',
    status: 'waiting',
    escalationReason: 'Account changes require identity verification by a human agent',
    turns: [
      { role: 'user', content: 'Please delete my account.', provider: 'demo' },
      { role: 'assistant', content: HANDOFF_ACCOUNT, provider: 'demo' },
      { role: 'system', content: 'Escalated to a human agent: Account changes require identity verification by a human agent', provider: 'demo' },
    ],
  },
];

const DEMO_CUSTOMERS: Array<{ name: string; email: string }> = [
  { name: 'Maya Chen', email: 'maya.chen@example.com' },
  { name: 'Daniel Okafor', email: 'd.okafor@example.com' },
  { name: 'Sofia Marchetti', email: 'sofia.m@example.com' },
  { name: 'Liam Whitfield', email: 'liam.whitfield@example.com' },
  { name: 'Priyanka Rao', email: 'priyanka.rao@example.com' },
  { name: 'Tomas Novak', email: 'tomas.novak@example.com' },
  { name: 'Aisha Bello', email: 'aisha.bello@example.com' },
  { name: 'Noah Lindqvist', email: 'noah.l@example.com' },
  { name: 'Hannah Mbeki', email: 'hannah.mbeki@example.com' },
  { name: 'Marco Ruiz', email: 'marco.ruiz@example.com' },
  { name: 'Elena Petrova', email: 'elena.petrova@example.com' },
  { name: 'Jonas Weber', email: 'jonas.weber@example.com' },
  { name: 'Chloe Dubois', email: 'chloe.dubois@example.com' },
  { name: 'Ravi Menon', email: 'ravi.menon@example.com' },
  { name: 'Grace Kim', email: 'grace.kim@example.com' },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedDemoConversations(): Promise<void> {
  const now = Date.now();
  const rand = mulberry32(20260918);

  for (let index = 0; index < SEED_SCENARIOS.length; index += 1) {
    const scenario = SEED_SCENARIOS[index];
    const customer = DEMO_CUSTOMERS[index % DEMO_CUSTOMERS.length];
    const dayOffset = index % 7;
    const shiftMinutes = (index % 9) * 37 + 20;
    const startedAt = new Date(now - dayOffset * 86400000 - shiftMinutes * 60000);

    const conversationId = newId();
    let cursor = startedAt.getTime();
    let updatedAt = startedAt.toISOString();

    const doc: ConversationDoc = {
      _id: conversationId,
      customer: customer.name,
      email: customer.email,
      title: scenario.title,
      intent: scenario.intent,
      status: scenario.status,
      assignee: scenario.assignee ?? null,
      rating: scenario.rating ?? null,
      escalation_reason: scenario.escalationReason ?? null,
      is_demo: true,
      low_confidence_streak: 0,
      unresolved_streak: 0,
      preview: '',
      human_handled: scenario.turns.some((turn) => turn.role === 'human'),
      token_hashes: [],
      created_at: startedAt.toISOString(),
      updated_at: startedAt.toISOString(),
    };

    await conversations().insertOne(doc);

    for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
      const turn = scenario.turns[turnIndex];
      if (turnIndex > 0) {
        cursor += turn.role === 'user' ? 45000 + Math.floor(rand() * 90000) : 20000 + Math.floor(rand() * 40000);
      }
      const createdAt = new Date(cursor).toISOString();
      updatedAt = createdAt;

      await messages().insertOne({
        _id: newId(),
        conversation_id: conversationId,
        role: turn.role,
        content: turn.content,
        provider: turn.provider ?? null,
        sources: turn.sources ?? [],
        tool: turn.tool ?? null,
        created_at: createdAt,
      });
    }

    const lastUser = [...scenario.turns].reverse().find((turn) => turn.role === 'user');
    await conversations().updateOne(
      { _id: conversationId },
      { $set: { updated_at: updatedAt, preview: truncatePreview(lastUser?.content ?? '') } },
    );
  }
}

async function seedFaqsIfEmpty(): Promise<void> {
  const count = await faqsCollection().countDocuments();
  if (count > 0) return;
  const updatedAt = nowIso();
  await withTransaction(async () => {
    for (const faq of SEED_FAQS) {
      await faqsCollection().insertOne({
        _id: faq.id,
        title: faq.title,
        answer: faq.answer,
        category: faq.category,
        tags: faq.tags,
        updated_at: updatedAt,
      });
    }
  });
}

async function seedDemoConversationsIfNeeded(): Promise<void> {
  if (process.env.SEED_DEMO === 'false') return;
  if (IS_LIVE) return;

  const marker = await meta().findOne({ _id: 'demo_seeded' });
  if (marker) return;

  const count = await conversations().countDocuments();
  if (count > 0) {
    await meta().updateOne(
      { _id: 'demo_seeded' },
      { $set: { value: nowIso() } },
      { upsert: true },
    );
    return;
  }

  await withTransaction(async () => {
    await seedDemoConversations();
    await meta().updateOne(
      { _id: 'demo_seeded' },
      { $set: { value: nowIso() } },
      { upsert: true },
    );
  });
}

/**
 * Seeds FAQs (always, when empty) and clearly-labelled demo conversations
 * (once). Called during server startup after the database connection opens.
 */
export async function seedDatabase(): Promise<void> {
  await seedFaqsIfEmpty();
  await seedDemoConversationsIfNeeded();
}
