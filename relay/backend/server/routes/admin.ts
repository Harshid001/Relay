/**
 * Admin routes: conversation queue, stats/usage, FAQ writes, knowledge gaps
 * and onboarding. Mounted on both /api and /api/v1 (the versioned mount
 * envelopes). Reads require an authenticated user; admin-only mutations
 * require the admin role (see server/auth.ts).
 */

import type { RequestHandler, Router } from 'express';

import { DEFAULT_ASSIGNEE } from '../agent.js';
import { MODE } from '../config.js';
import * as store from '../db.js';
import { emitConversation, publish } from '../events.js';
import { wrap } from '../http.js';
import { clearFaqTermCache, INTENTS } from '../knowledge.js';
import { currentMonthWindow, getUsageSummary, type UsageSummary } from '../plan.js';
import { rateLimit } from '../ratelimit.js';
import {
  MAX_ANSWER,
  MAX_ASSIGNEE,
  MAX_CONTENT,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE,
  asRecord,
  parseIntent,
  parseTags,
  readOptionalString,
  readRequiredString,
} from '../validation.js';

export interface AdminDeps {
  requireUser: RequestHandler;
  requireAdminRole: RequestHandler;
}

/**
 * Free-plan usage for the current calendar month (admin visibility). The
 * dashboard reads this on every settings/poll cycle, so a short TTL cache
 * avoids two countDocuments() scans per read. Enforcement paths deliberately
 * read live counts and are never cached.
 */
const USAGE_CACHE_MS = 15_000;
let usageCache: { at: number; value: UsageSummary } | null = null;

export function registerAdminRoutes(router: Router, deps: AdminDeps): void {
  const apiLimiter = rateLimit('api', 600, 60_000);
  const writeLimiter = rateLimit('write', 120, 60_000);

  /* Admin - conversations */

  router.get('/admin/conversations', apiLimiter, deps.requireUser, wrap(async (req, res) => {
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

  router.get(
    '/admin/conversations/:id',
    apiLimiter,
    deps.requireUser,
    wrap(async (req, res) => {
      const conversation = await store.getConversation(req.params.id);
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      res.json({ conversation, messages: await store.getMessages(conversation.id) });
    }),
  );

  router.get('/admin/stats', apiLimiter, deps.requireUser, wrap(async (req, res) => {
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

  /** Free-plan usage for the current calendar month (admin visibility). */
  router.get('/admin/usage', apiLimiter, deps.requireUser, wrap(async (_req, res) => {
    if (usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) {
      res.json(usageCache.value);
      return;
    }
    const { start } = currentMonthWindow();
    const value = await getUsageSummary({
      conversations: () => store.countConversationsSince(start),
      aiMessages: () => store.countAssistantMessagesSince(start),
    });
    usageCache = { at: Date.now(), value };
    res.json(value);
  }));

  router.post(
    '/admin/conversations/:id/reply',
    writeLimiter,
    deps.requireUser,
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

  router.post(
    '/admin/conversations/:id/resolve',
    writeLimiter,
    deps.requireUser,
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

  router.post(
    '/admin/conversations/:id/assign',
    writeLimiter,
    deps.requireUser,
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

  /* Admin - FAQs */

  router.post('/admin/faqs', writeLimiter, deps.requireAdminRole, wrap(async (req, res) => {
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

    const created = await store.createFaq({ title, answer, category, tags });
    clearFaqTermCache();
    publish({ type: 'faq' });
    res.status(201).json(created);
  }));

  router.patch('/admin/faqs/:id', writeLimiter, deps.requireAdminRole, wrap(async (req, res) => {
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
    clearFaqTermCache();
    publish({ type: 'faq' });
    res.json(updated);
  }));

  router.get('/admin/knowledge-gaps', apiLimiter, deps.requireUser, wrap(async (_req, res) => {
    res.json({ items: await store.listKnowledgeGaps() });
  }));

  router.post('/admin/knowledge-gaps/:id/resolve', writeLimiter, deps.requireUser, wrap(async (req, res) => {
    const resolved = await store.resolveKnowledgeGap(req.params.id);
    if (!resolved) {
      res.status(404).json({ error: 'Knowledge gap not found' });
      return;
    }
    res.json({ ok: true });
  }));

  router.post('/admin/onboarding/sample-knowledge', writeLimiter, deps.requireAdminRole, wrap(async (_req, res) => {
    const faqs = await store.seedSampleKnowledge();
    clearFaqTermCache();
    publish({ type: 'faq' });
    res.json({ items: faqs });
  }));
}
