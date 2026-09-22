/**
 * Relay Store support backend - HTTP API.
 *
 * Express 4, bound to 127.0.0.1:3000 only by default (set HOST/PORT to change).
 * Serves the production frontend from `dist/` with an SPA fallback and exposes
 * the customer + admin API contract.
 *
 * Modes:
 *   - demo (default): public local prototype. Every seeded conversation is marked
 *     `isDemo: true`; the frontend labels it. Admin routes are open on loopback.
 *   - live (CODEBUDDY_LIVE=true): requires ADMIN_TOKEN, otherwise startup fails.
 *
 * Persistence is MongoDB (server/db.ts); startup connects, seeds, then listens.
 * Credentials never reach the client: only the health endpoint reports the mode.
 */

import express, { type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './db.js';
import { INTENTS, type Intent } from './knowledge.js';
import {
  DEFAULT_ASSIGNEE,
  generateDemoTurn,
  generateLiveTurn,
  handoffMessage,
  isLiveMode,
  type AgentTurnResult,
  type ToolEvent,
  type TurnHistoryItem,
} from './agent.js';
import * as auth from './auth.js';
import { authRouter } from './auth-routes.js';
import { publish, subscribe } from './events.js';
import { notifyOnEvent } from './notify.js';
import { requestLogging } from './logger.js';
import { envelope, fail, metricsMiddleware, metricsText, ok } from './http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const LIVE = isLiveMode();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN ?? '').trim();
const ADMIN_AUTH_REQUIRED = ADMIN_TOKEN.length > 0;

if (LIVE && !ADMIN_AUTH_REQUIRED) {
  console.error(
    '[relay] CODEBUDDY_LIVE=true requires ADMIN_TOKEN to be set. Refusing to start in live mode without admin authentication.',
  );
  process.exit(1);
}

const MODE: 'demo' | 'live' = LIVE ? 'live' : 'demo';

const MAX_CONTENT = 4000;
const MAX_EMAIL = 200;
const MAX_CUSTOMER = 80;
const MAX_REASON = 300;
const MAX_TITLE = 200;
const MAX_ANSWER = 4000;
const MAX_ASSIGNEE = 80;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 40;
const MAX_CLIENT_ID = 120;

/**
 * Hostnames this deployment answers for. Loopback is always allowed so the
 * local prototype and container healthchecks work out of the box; production
 * adds its public name(s) via ALLOWED_HOSTS (comma-separated, e.g. the DOMAIN
 * value). Requests whose Host or Origin header is not on the list are
 * rejected with 403. Set ALLOWED_HOSTS="*" to disable the check entirely —
 * not recommended: the Origin guard is what blocks cross-site writes against
 * cookie sessions.
 */
const ALLOWED_HOSTNAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  ...(process.env.ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
]);
const ALLOW_ALL_HOSTS = ALLOWED_HOSTNAMES.has('*');

/* ------------------------------------------------------------------ *
 * App + middleware
 * ------------------------------------------------------------------ */

export const app = express();

app.disable('x-powered-by');
// Behind a TLS-terminating proxy (Caddy, Cloudflare, Vercel, …) the socket
// address is the proxy's: set TRUST_PROXY to the number of proxy hops in
// front of the app (1 for a single Caddy/nginx, 2 when Cloudflare proxies
// into Caddy, …) so Express resolves req.ip from X-Forwarded-For and rate
// limits plus secure-cookie detection key on the real client. A hop count —
// not "true" — is spoof-proof: entries left of the trusted hops are ignored.
// Never enable it on a port exposed directly to the internet.
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY ?? '', 10);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false);

/**
 * Express 4 does not catch rejected promises from async handlers. Every async
 * route is wrapped so rejections become proper 500 responses instead of
 * unhandled rejections that leave the request hanging.
 */
function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Relay-Mode', MODE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Host / Origin safeguard: only loopback plus ALLOWED_HOSTS (production)
  // may address this server; anything else gets 403.
  const hostHeader = String(req.headers.host ?? '');
  if (hostHeader) {
    const match = hostHeader.match(/^(\[[^\]]+\]|[^:]+)/);
    const hostname = (match ? match[1] : hostHeader).toLowerCase();
    if (!ALLOW_ALL_HOSTS && !ALLOWED_HOSTNAMES.has(hostname)) {
      res.status(403).json({ error: 'Forbidden host' });
      return;
    }
  }

  const origin = req.headers.origin;
  if (origin === 'null') {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  if (typeof origin === 'string' && origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
    if (!ALLOW_ALL_HOSTS && !ALLOWED_HOSTNAMES.has(originHost)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return;
    }
  }

  next();
});

app.use(express.json({ limit: '32kb' }));

// Correlated structured logs + Prometheus-style metrics for every request.
app.use(requestLogging());
app.use(metricsMiddleware());

// ---- Versioned API ---------------------------------------------------
// /api/v1/* serves the enveloped contract ({ success, data | error }).
// The legacy /api/* mount below stays unwrapped for backward compatibility.
const v1 = express.Router();
v1.use(envelope);
app.use('/api/v1', v1);

// Deep health + metrics are unversioned, cheap, and probe-friendly.
app.get('/api/health', async (_req: Request, res: Response) => {
  let database = 'down';
  try {
    await store.getDb().command({ ping: 1 });
    database = 'up';
  } catch {
    database = 'down';
  }
  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    mode: MODE,
    checks: { database },
    adminAuthRequired: ADMIN_AUTH_REQUIRED,
  });
});

app.get('/api/metrics', (_req: Request, res: Response) => {
  res.type('text/plain; version=0.0.4').send(metricsText());
});

/* ------------------------------------------------------------------ *
 * Realtime: admin Server-Sent Events stream
 * (registered AFTER auth.attachUser below - see app.use ordering)
 * ------------------------------------------------------------------ */

/** Publishes a conversation event and triggers any email notification. */
function emitConversation(id: string, status: string | null, title?: string): void {
  publish({ type: 'conversation', id, status });
  void notifyOnEvent({ type: 'conversation', id, status }, title);
}

/* ------------------------------------------------------------------ *
 * In-memory rate limiting
 * (single-instance only; move to a shared store for horizontal scaling)
 * ------------------------------------------------------------------ */

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

function rateLimit(name: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}|${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: 'Too many requests. Please slow down.' });
      return;
    }
    next();
  };
}

const apiLimiter = rateLimit('api', 600, 60_000);
const writeLimiter = rateLimit('write', 120, 60_000);
const messageLimiter = rateLimit('message', 40, 60_000);

const rateCleanup = setInterval(() => {
  const now = Date.now();
  rateBuckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  });
}, 5 * 60_000);
rateCleanup.unref?.();

/* ------------------------------------------------------------------ *
 * Auth helpers
 * ------------------------------------------------------------------ */

function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/** Conversation owner guard - 404 for both missing and invalid tokens. */
const requireConversationAccess: RequestHandler = wrap(async (req, res, next) => {
  const conversationId = req.params.id;
  const token = req.get('x-conversation-token') ?? '';
  if (!conversationId || !token || !(await store.verifyConversationToken(conversationId, token))) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  next();
});

/**
 * Unified admin guard: req.user is set either by a cookie session or by the
 * legacy shared-token path inside attachUser (which only activates while no
 * accounts exist). Agents can read the workspace; admins-only routes use
 * requireAdminRole below.
 */
function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/** Admin-only mutations (FAQ writes, role changes). */
function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function readRequiredString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function readOptionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > max) return null;
  return trimmed;
}

function parseIntent(value: unknown): Intent | null {
  return typeof value === 'string' && (INTENTS as string[]).includes(value)
    ? (value as Intent)
    : null;
}

function parseTags(value: unknown): string[] | null {
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

/* ------------------------------------------------------------------ *
 * Per-conversation busy lock
 * (in-memory; single-instance only)
 * ------------------------------------------------------------------ */

const busyConversations = new Set<string>();

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

// Auth: attach user, then the auth router.
app.use(auth.attachUser);
app.use('/api/auth', authRouter);

// Admin SSE stream - must be registered after attachUser so the session
// cookie is resolved before the guard runs.
app.get('/api/admin/events', requireUser, (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const unsubscribe = subscribe(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleanup below handles removal */
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/* ------------------------------------------------------------------ *
 * Public FAQs
 * ------------------------------------------------------------------ */

app.get('/api/faqs', apiLimiter, wrap(async (_req, res) => {
  res.json(await store.listFaqs());
}));

/* ------------------------------------------------------------------ *
 * Customer conversations
 * ------------------------------------------------------------------ */

app.post('/api/conversations', writeLimiter, wrap(async (req, res) => {
  const body = asRecord(req.body);

  const customer = readOptionalString(body.customer, MAX_CUSTOMER);
  if (customer === null) {
    res.status(400).json({ error: `customer must be at most ${MAX_CUSTOMER} characters` });
    return;
  }

  const email = readOptionalString(body.email, MAX_EMAIL);
  if (email === null) {
    res.status(400).json({ error: `email must be at most ${MAX_EMAIL} characters` });
    return;
  }

  const created = await store.createConversation({ customer, email });
  emitConversation(created.conversation.id, created.conversation.status, created.conversation.title);
  res.status(201).json({ conversation: created.conversation, accessToken: created.accessToken });
}));

app.get(
  '/api/conversations/:id',
  apiLimiter,
  requireConversationAccess,
  wrap(async (req, res) => {
    const conversation = await store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation, messages: await store.getMessages(conversation.id) });
  }),
);

app.post(
  '/api/conversations/:id/messages',
  messageLimiter,
  requireConversationAccess,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const body = asRecord(req.body);

    const content = readRequiredString(body.content, MAX_CONTENT);
    if (!content) {
      res.status(400).json({
        error: `content is required and must be at most ${MAX_CONTENT} characters`,
      });
      return;
    }

    let clientId: string | null = null;
    if (body.clientId !== undefined && body.clientId !== null) {
      const parsed = readRequiredString(body.clientId, MAX_CLIENT_ID);
      if (!parsed) {
        res.status(400).json({ error: `clientId must be at most ${MAX_CLIENT_ID} characters` });
        return;
      }
      clientId = parsed;
    }

    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Idempotent retry: the same clientId returns the current state unchanged.
    if (clientId && (await store.hasIdempotencyKey(conversationId, clientId))) {
      res.json({ conversation: existing, messages: await store.getMessages(conversationId) });
      return;
    }

    if (busyConversations.has(conversationId)) {
      res.status(409).json({
        error: 'A reply is already being generated for this conversation. Please wait.',
      });
      return;
    }

    busyConversations.add(conversationId);
    try {
      const row = await store.getConversationRow(conversationId);
      const previousLowStreak = Number(row?.low_confidence_streak ?? 0);
      const previousUnresolvedStreak = Number(row?.unresolved_streak ?? 0);
      const previousIntent: Intent | null = existing.intent ?? null;
      const wasWaiting = existing.status === 'waiting';
      const wasResolved = existing.status === 'resolved';

      /**
       * A human can resolve, escalate or reply while the assistant turn is still
       * running (live turns may take up to 30s). Their status decision must win:
       * we never silently re-queue a conversation a person just closed.
       */
      const humanTookOver = async () => {
        const latest = await store.getConversationRow(conversationId);
        return latest !== null && latest.status !== existing.status;
      };

      const history: TurnHistoryItem[] = (await store.getMessages(conversationId))
        .filter((message) => message.role !== 'system')
        .map((message) => ({ role: message.role, content: message.content }));

      await store.addMessage({ conversationId, role: 'user', content });

      if (clientId) await store.recordIdempotencyKey(conversationId, clientId);

      /** Scripted tool events from this turn, e.g. an order lookup. */
      let toolEvent: ToolEvent | null = null;

      const basePatch: store.ConversationPatch = {};
      if (existing.title === 'New conversation') {
        basePatch.title = content.length > 60 ? `${content.slice(0, 59)}\u2026` : content;
      }
      if (wasResolved) {
        basePatch.status = 'open';
        basePatch.escalationReason = null;
        await store.addMessage({
          conversationId,
          role: 'system',
          content: 'Customer reopened this conversation after it was marked resolved.',
        });
      }

      // Waiting conversations are owned by the human queue: store the message,
      // never let the assistant answer on top of a human hand-off.
      if (wasWaiting) {
        await store.updateConversation(conversationId, basePatch);
        const conversation = await store.getConversation(conversationId);
        emitConversation(conversationId, conversation?.status ?? 'waiting', conversation?.title ?? undefined);
        res.json({ conversation, messages: await store.getMessages(conversationId) });
        return;
      }

      // Optional artificial latency. Off by default; useful for exercising the
      // loading and hand-off states locally, and for deterministic tests.
      const turnDelayMs = Number(process.env.RELAY_TURN_DELAY_MS ?? 0);
      if (Number.isFinite(turnDelayMs) && turnDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(turnDelayMs, 30_000)));
      }

      let turn: AgentTurnResult;
      try {
        if (LIVE) {
          turn = await generateLiveTurn({
            conversationId,
            customer: existing.customer,
            userText: content,
            history,
            faqs: await store.listFaqs(),
            previousIntent,
          });
        } else {
          turn = generateDemoTurn({
            userText: content,
            faqs: await store.listFaqs(),
            previousIntent,
          });
        }
      } catch (error) {
        console.error('[relay] assistant failure:', error);
        await store.addMessage({
          conversationId,
          role: 'assistant',
          content: handoffMessage('service_unavailable'),
        });
        const takenOver = await humanTookOver();
        if (!takenOver) {
          await store.addMessage({
            conversationId,
            role: 'system',
            content: 'Escalated to a human agent: assistant service unavailable',
          });
        }
        await store.updateConversation(conversationId, {
          ...basePatch,
          intent: previousIntent ?? 'general',
          ...(takenOver
            ? {}
            : {
                status: 'waiting' as const,
                escalationReason: 'Assistant service unavailable',
              }),
          lowConfidenceStreak: 0,
          unresolvedStreak: 0,
        });
        const conversation = await store.getConversation(conversationId);
        emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
        res.json({ conversation, messages: await store.getMessages(conversationId) });
        return;
      }

      await store.addMessage({
        conversationId,
        role: 'assistant',
        content: turn.reply,
        provider: turn.provider,
        sources: turn.sources,
        ...(turn.toolCall ? { tool: { name: turn.toolCall.name, args: turn.toolCall.args } } : {}),
      });

      if (turn.toolCall) {
        toolEvent = { name: turn.toolCall.name, args: turn.toolCall.args };
      }

      const lowStreak = turn.confidence === 'low' ? previousLowStreak + 1 : 0;
      const reportedUnresolved = /\b(still (?:not|does(?:n['’]?t| not)|is(?:n['’]?t| not)|can(?:not|'t))|(?:did(?:n['’]?t| not)|does(?:n['’]?t| not)) (?:work|help|fix)|not (?:working|helpful|resolved|fixed)|same (?:problem|issue|error)|tried (?:that|this|everything)|no (?:luck|change))\b/i.test(content);
      // A successful order lookup is a resolved turn by construction.
      const orderLookupResolved = Boolean(turn.toolCall);
      // In demo mode a missing citation means the knowledge base had no answer.
      // In live mode `sources` is only the retrieval context handed to the model,
      // so it says nothing about whether the model actually resolved the request;
      // there we rely on the customer's own words and the model's escalate flag.
      const unresolvedSignal = !orderLookupResolved
        && (reportedUnresolved || (!LIVE && turn.sources.length === 0));
      const unresolvedStreak = unresolvedSignal ? previousUnresolvedStreak + 1 : 0;

      let escalate = turn.escalate;
      let escalationReason = turn.escalationReason;

      if (!escalate && (lowStreak >= 2 || unresolvedStreak >= 2)) {
        escalate = true;
        escalationReason = 'Two consecutive unresolved messages or unsuccessful troubleshooting attempts';
        await store.addMessage({
          conversationId,
          role: 'assistant',
          content: handoffMessage('repeated_unresolved'),
          provider: turn.provider,
        });
      }

      const takenOver = await humanTookOver();
      if (takenOver) {
        console.log(
          `[relay] human changed the status of ${conversationId} during an assistant turn; keeping their decision`,
        );
      } else if (escalate) {
        await store.addMessage({
          conversationId,
          role: 'system',
          content: `Escalated to a human agent: ${escalationReason ?? 'unresolved request'}`,
        });
      }

      const patch: store.ConversationPatch = {
        ...basePatch,
        intent: turn.intent,
        lowConfidenceStreak: escalate ? 0 : lowStreak,
        unresolvedStreak: escalate ? 0 : unresolvedStreak,
      };
      if (takenOver) {
        // Drop any status/escalation change this turn wanted to make.
        delete patch.status;
        delete patch.escalationReason;
      } else if (escalate) {
        patch.status = 'waiting';
        patch.escalationReason = escalationReason ?? 'unresolved request';
      } else if (wasResolved) {
        patch.status = 'open';
        patch.escalationReason = null;
      }
      await store.updateConversation(conversationId, patch);

      const conversation = await store.getConversation(conversationId);
      emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
      res.json({ conversation, messages: await store.getMessages(conversationId), ...(toolEvent ? { toolEvent } : {}) });
    } finally {
      busyConversations.delete(conversationId);
    }
  }),
);

app.post(
  '/api/conversations/:id/escalate',
  writeLimiter,
  requireConversationAccess,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const body = asRecord(req.body);
    const reason = readOptionalString(body.reason, MAX_REASON);
    if (reason === null) {
      res.status(400).json({ error: `reason must be at most ${MAX_REASON} characters` });
      return;
    }

    const finalReason = reason && reason.length > 0 ? reason : 'Customer requested a human agent';

    await store.addMessage({
      conversationId,
      role: 'system',
      content: `Escalated to a human agent: ${finalReason}`,
    });

    const conversation = await store.updateConversation(conversationId, {
      status: 'waiting',
      escalationReason: finalReason,
      lowConfidenceStreak: 0,
      unresolvedStreak: 0,
    });

    emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
    res.json(conversation);
  }),
);

app.post(
  '/api/conversations/:id/rating',
  writeLimiter,
  requireConversationAccess,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const body = asRecord(req.body);
    const score = body.score;
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      res.status(400).json({ error: 'score must be an integer between 1 and 5' });
      return;
    }

    if (existing.rating !== null) {
      res.status(409).json({ error: 'This conversation has already been rated.' });
      return;
    }

    const conversation = await store.updateConversation(conversationId, { rating: score });
    emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
    res.json(conversation);
  }),
);

/* ------------------------------------------------------------------ *
 * Admin - conversations
 * ------------------------------------------------------------------ */

app.get('/api/admin/conversations', apiLimiter, requireUser, wrap(async (req, res) => {
  // Pagination: newest first, bounded page size.
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  const result = await store.listConversations({ limit, offset });
  res.json({
    items: result.items,
    total: result.total,
    limit,
    offset,
  });
}));

app.get(
  '/api/admin/conversations/:id',
  apiLimiter,
  requireUser,
  wrap(async (req, res) => {
    const conversation = await store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation, messages: await store.getMessages(conversation.id) });
  }),
);

app.get('/api/admin/stats', apiLimiter, requireUser, wrap(async (req, res) => {
  const raw = req.query.days;
  let days = 7;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (parsed !== 7 && parsed !== 30) {
      res.status(400).json({ error: 'days must be 7 or 30' });
      return;
    }
    days = parsed;
  }

  res.json({ ...(await store.getStats(days)), mode: MODE });
}));

app.post(
  '/api/admin/conversations/:id/reply',
  writeLimiter,
  requireUser,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const body = asRecord(req.body);
    const content = readRequiredString(body.content, MAX_CONTENT);
    if (!content) {
      res.status(400).json({
        error: `content is required and must be at most ${MAX_CONTENT} characters`,
      });
      return;
    }

    // Status is intentionally untouched: an escalated conversation stays in the
    // waiting queue until a human explicitly resolves it.
    const message = await store.addMessage({
      conversationId,
      role: 'human',
      content,
      provider: 'human',
    });

    const afterReply = await store.getConversation(conversationId);
    emitConversation(conversationId, afterReply?.status ?? null, afterReply?.title ?? undefined);
    res.json(message);
  }),
);

app.post(
  '/api/admin/conversations/:id/resolve',
  writeLimiter,
  requireUser,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    await store.addMessage({
      conversationId,
      role: 'system',
      content: 'Conversation marked as resolved by a human agent.',
    });

    const conversation = await store.updateConversation(conversationId, {
      status: 'resolved',
      escalationReason: null,
      lowConfidenceStreak: 0,
      unresolvedStreak: 0,
    });

    emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
    res.json(conversation);
  }),
);

app.post(
  '/api/admin/conversations/:id/assign',
  writeLimiter,
  requireUser,
  wrap(async (req, res) => {
    const conversationId = req.params.id;
    const existing = await store.getConversation(conversationId);
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const body = asRecord(req.body);
    const name = readOptionalString(body.name, MAX_ASSIGNEE);
    if (name === null) {
      res.status(400).json({ error: `name must be at most ${MAX_ASSIGNEE} characters` });
      return;
    }

    const assignee = name && name.length > 0 ? name : DEFAULT_ASSIGNEE;
    const conversation = await store.updateConversation(conversationId, { assignee });
    emitConversation(conversationId, conversation?.status ?? null, conversation?.title ?? undefined);
    res.json(conversation);
  }),
);

/* ------------------------------------------------------------------ *
 * Admin - FAQs
 * ------------------------------------------------------------------ */

app.post('/api/admin/faqs', writeLimiter, requireAdminRole, wrap(async (req, res) => {
  const body = asRecord(req.body);

  const title = readRequiredString(body.title, MAX_TITLE);
  if (!title) {
    res.status(400).json({ error: `title is required and must be at most ${MAX_TITLE} characters` });
    return;
  }

  const answer = readRequiredString(body.answer, MAX_ANSWER);
  if (!answer) {
    res.status(400).json({ error: `answer is required and must be at most ${MAX_ANSWER} characters` });
    return;
  }

  const category = parseIntent(body.category);
  if (!category) {
    res.status(400).json({ error: `category must be one of: ${INTENTS.join(', ')}` });
    return;
  }

  const tags = parseTags(body.tags);
  if (!tags) {
    res.status(400).json({
      error: `tags must be an array of at most ${MAX_TAGS} strings, each at most ${MAX_TAG_LENGTH} characters`,
    });
    return;
  }

  res.status(201).json(await store.createFaq({ title, answer, category, tags }));
  publish({ type: 'faq' });
}));

app.patch('/api/admin/faqs/:id', writeLimiter, requireAdminRole, wrap(async (req, res) => {
  const faqId = req.params.id;
  if (!(await store.getFaq(faqId))) {
    res.status(404).json({ error: 'FAQ not found' });
    return;
  }

  const body = asRecord(req.body);
  const applied: Partial<store.FaqInput> = {};
  let touched = false;

  if (body.title !== undefined) {
    const title = readRequiredString(body.title, MAX_TITLE);
    if (!title) {
      res.status(400).json({ error: `title must be at most ${MAX_TITLE} characters` });
      return;
    }
    applied.title = title;
    touched = true;
  }

  if (body.answer !== undefined) {
    const answer = readRequiredString(body.answer, MAX_ANSWER);
    if (!answer) {
      res.status(400).json({ error: `answer must be at most ${MAX_ANSWER} characters` });
      return;
    }
    applied.answer = answer;
    touched = true;
  }

  if (body.category !== undefined) {
    const category = parseIntent(body.category);
    if (!category) {
      res.status(400).json({ error: `category must be one of: ${INTENTS.join(', ')}` });
      return;
    }
    applied.category = category;
    touched = true;
  }

  if (body.tags !== undefined) {
    const tags = parseTags(body.tags);
    if (!tags) {
      res.status(400).json({
        error: `tags must be an array of at most ${MAX_TAGS} strings, each at most ${MAX_TAG_LENGTH} characters`,
      });
      return;
    }
    applied.tags = tags;
    touched = true;
  }

  if (!touched) {
    res.status(400).json({ error: 'No updatable fields were provided' });
    return;
  }

  const updated = await store.updateFaq(faqId, applied);
  if (!updated) {
    res.status(404).json({ error: 'FAQ not found' });
    return;
  }
  res.json(updated);
  publish({ type: 'faq' });
}));

/* ------------------------------------------------------------------ *
 * API 404 + static frontend + SPA fallback
 * ------------------------------------------------------------------ */

app.use('/api', apiLimiter, (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

const DIST_DIR = path.join(store.PROJECT_ROOT, 'dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { index: false }));
}

app.get(/^\/(?!api(?:\/|$)).*/, (req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    next();
    return;
  }
  if (!fs.existsSync(INDEX_FILE)) {
    res.status(404).json({ error: 'Frontend build not found. Run the build first.' });
    return;
  }
  res.sendFile(INDEX_FILE);
});

/* ------------------------------------------------------------------ *
 * Error handler
 * ------------------------------------------------------------------ */

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const err = error as { type?: string; status?: number; statusCode?: number; message?: string };

  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  console.error('[relay] unhandled error:', error);
  const status = err?.status ?? err?.statusCode ?? 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: 'Internal server error' });
});

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

export async function startServer(port: number = PORT, host: string = HOST) {
  await store.connectToDatabase();
  await store.seedDatabase();
  await auth.initAuthCollections(store.getDb());
  await auth.bootstrapAdminFromEnv();

  const server = app.listen(port, host, () => {
    console.log(`[relay] Relay Store support backend listening on http://${host}:${port}`);
    console.log(`[relay] mode=${MODE} adminAuthRequired=${ADMIN_AUTH_REQUIRED} db=mongodb://${store.DB_NAME}`);
    if (!LIVE) {
      console.log('[relay] demo mode: public local prototype, seeded conversations are marked isDemo=true');
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`[relay] ${signal} received, shutting down…`);
    server.close(async () => {
      await store.closeDatabase();
      process.exit(0);
    });
    // Force-exit if connections do not drain in time.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').toLowerCase();
  const self = normalize(__filename);
  const resolvedEntry = normalize(entry);
  return resolvedEntry === self || resolvedEntry === self.replace(/\.ts$/, '.js');
}

if (isMainModule() && process.env.RELAY_NO_LISTEN !== '1') {
  startServer().catch((error) => {
    console.error('[relay] failed to start:', error);
    process.exit(1);
  });
}

export { store as dbStore };
export default app;
