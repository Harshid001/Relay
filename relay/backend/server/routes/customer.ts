/**
 * Customer-facing routes: FAQs and owner-token-protected conversations.
 * Mounted on both /api and /api/v1 (the versioned mount envelopes).
 */

import type { RequestHandler, Router } from 'express';

import {
  generateDemoTurn,
  generateLiveTurn,
  handoffMessage,
  type AgentTurnResult,
  type ToolEvent,
  type TurnHistoryItem,
} from '../agent.js';
import { LIVE } from '../config.js';
import * as store from '../db.js';
import { emitConversation } from '../events.js';
import { wrap } from '../http.js';
import type { Intent } from '../knowledge.js';
import {
  METERING_ENABLED,
  aiMessagesLimitReached,
  conversationsLimitReached,
  currentMonthWindow,
  limitMessage,
} from '../plan.js';
import { acquireTurnLock, rateLimit, releaseTurnLock } from '../ratelimit.js';
import { telemetry } from '../telemetry.js';
import {
  MAX_CLIENT_ID,
  MAX_CONTENT,
  MAX_CUSTOMER,
  MAX_EMAIL,
  MAX_REASON,
  asRecord,
  readOptionalString,
  readRequiredString,
} from '../validation.js';

export function registerCustomerRoutes(router: Router): void {
  const apiLimiter = rateLimit('api', 600, 60_000);
  const writeLimiter = rateLimit('write', 120, 60_000);
  const messageLimiter = rateLimit('message', 40, 60_000);

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

  /* Public FAQs */

  router.get('/faqs', apiLimiter, wrap(async (_req, res) => {
    res.json(await store.listFaqs());
  }));

  /* Customer conversations */

  router.post('/conversations', writeLimiter, wrap(async (req, res) => {
    // Free-plan guard: new conversations stop at the monthly cap; existing
    // threads and human hand-offs stay available.
    if (METERING_ENABLED) {
      const { start } = currentMonthWindow();
      const used = await store.countConversationsSince(start);
      const hit = conversationsLimitReached(used);
      if (hit) {
        telemetry.recordPlanLimitRejection('conversations');
        res.setHeader('Retry-After', String(Math.max(1, 3600)));
        res.status(429).json({ error: limitMessage(hit) });
        return;
      }
    }

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

  router.get(
    '/conversations/:id',
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

  router.post(
    '/conversations/:id/messages',
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

      // Distributed turn lock: claimed up front so two concurrent turns (even
      // on different instances) cannot both generate. Releasing happens in the
      // finally below; a crashed holder's lock expires via TTL.
      if (!(await acquireTurnLock(conversationId))) {
        res.status(409).json({
          error: 'A reply is already being generated for this conversation. Please wait.',
        });
        return;
      }

      // Free-plan guard: assistant turns stop at the monthly cap. Storing the
      // customer's message and reaching a human always stay available.
      if (METERING_ENABLED && existing.status !== 'waiting') {
        const { start } = currentMonthWindow();
        const used = await store.countAssistantMessagesSince(start);
        const hit = aiMessagesLimitReached(used);
        if (hit) {
          telemetry.recordPlanLimitRejection('ai_messages');
          await store.addMessage({ conversationId, role: 'user', content });
          await store.addMessage({
            conversationId,
            role: 'assistant',
            content: limitMessage(hit),
          });
          await store.addMessage({
            conversationId,
            role: 'system',
            content: 'Escalated to human queue: Monthly assistant message cap reached.',
          });
          const updated = await store.updateConversation(conversationId, {
            status: 'waiting',
            escalationReason: 'Monthly AI message cap reached',
          });
          emitConversation(conversationId, 'waiting', updated?.title ?? undefined);
          res.status(429).json({
            error: limitMessage(hit),
            aiMessagesLimitReached: true,
            conversation: updated,
            messages: await store.getMessages(conversationId),
          });
          return;
        }
      }

      // The turn lock was claimed above; everything below runs under it.
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
        const aiStart = process.hrtime.bigint();
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
          const aiDurationMs = Number(process.hrtime.bigint() - aiStart) / 1e6;
          telemetry.recordAiTurn(true, aiDurationMs);
          telemetry.recordKbSearch(turn.sources.length > 0);
        } catch (error) {
          const aiDurationMs = Number(process.hrtime.bigint() - aiStart) / 1e6;
          telemetry.recordAiTurn(false, aiDurationMs);
          telemetry.recordHandoff('assistant_service_unavailable');
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
          telemetry.recordHandoff(escalationReason ?? 'unresolved request');
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
        await releaseTurnLock(conversationId);
      }
    }),
  );

  router.post(
    '/conversations/:id/escalate',
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
      telemetry.recordHandoff(finalReason);

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

  router.post(
    '/conversations/:id/rating',
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

  router.post(
    '/conversations/:id/messages/:messageId/feedback',
    writeLimiter,
    requireConversationAccess,
    wrap(async (req, res) => {
      const { id: conversationId, messageId } = req.params;
      const body = asRecord(req.body);
      const helpful = Boolean(body.helpful);
      const validReasons = ['incorrect', 'didnt_answer', 'missing_info', 'need_human'];
      const reason = typeof body.reason === 'string' && validReasons.includes(body.reason)
        ? (body.reason as 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human')
        : null;
      const comment = readOptionalString(body.comment, 500) ?? null;

      const updatedMessage = await store.recordMessageFeedback(conversationId, messageId, {
        helpful,
        reason,
        comment,
      });

      if (!updatedMessage) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      if (!helpful && reason === 'need_human') {
        telemetry.recordHandoff('Customer requested human support via message feedback');
        const existing = await store.getConversation(conversationId);
        if (existing && existing.status !== 'waiting') {
          await store.addMessage({
            conversationId,
            role: 'system',
            content: 'Escalated to human agent: Customer flagged answer as needing a human.',
          });
          const updatedConv = await store.updateConversation(conversationId, {
            status: 'waiting',
            escalationReason: 'Customer requested human support via message feedback',
          });
          emitConversation(conversationId, updatedConv?.status ?? null, updatedConv?.title ?? undefined);
        }
      }

      res.json({ ok: true, message: updatedMessage });
    }),
  );
}
