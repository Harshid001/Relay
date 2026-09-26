/**
 * Relay free-tier metering.
 *
 * Relay is positioned as a free product:
 *   - Every workspace gets a generous free plan with simple monthly caps
 *     (defaults: 300 conversations/mo, 1000 AI assistant turns/mo). Human
 *     replies, escalations and ratings are never metered.
 *   - Self-hosters can raise or remove the caps with environment variables —
 *     `FREE_CONVERSATIONS_LIMIT=0` disables metering entirely.
 *
 * Counters are calendar-month aggregate counts over the existing collections,
 * so they stay correct across restarts and instances without a new stateful
 * service. The cost is two countDocuments() calls per usage read and one on
 * each metered write — cheap on the indexed `created_at` fields.
 */

function readLimit(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 0 disables the cap (unlimited). */
export const FREE_CONVERSATIONS_LIMIT = readLimit(process.env.FREE_CONVERSATIONS_LIMIT, 300);
export const FREE_AI_MESSAGES_LIMIT = readLimit(process.env.FREE_AI_MESSAGES_LIMIT, 1000);

/** True when at least one cap is enforced — controls metering middleware. */
export const METERING_ENABLED = FREE_CONVERSATIONS_LIMIT > 0 || FREE_AI_MESSAGES_LIMIT > 0;

/** Calendar-month window: first day of the current month, 00:00 local → now. */
export function currentMonthWindow(now = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
    end: now,
  };
}

export type UsageSummary = {
  plan: 'free';
  period: { start: string; end: string };
  conversationsUsed: number;
  conversationsLimit: number | null;
  aiMessagesUsed: number;
  aiMessagesLimit: number | null;
  /** Percent 0–100 of the tightest active cap, for UI meters. */
  percentUsed: number;
};

type Counters = { conversations: () => Promise<number>; aiMessages: () => Promise<number> };

export async function getUsageSummary(counters: Counters): Promise<UsageSummary> {
  const { start, end } = currentMonthWindow();
  const [conversationsUsed, aiMessagesUsed] = await Promise.all([
    counters.conversations(),
    counters.aiMessages(),
  ]);

  const fractions = [
    FREE_CONVERSATIONS_LIMIT > 0 ? conversationsUsed / FREE_CONVERSATIONS_LIMIT : 0,
    FREE_AI_MESSAGES_LIMIT > 0 ? aiMessagesUsed / FREE_AI_MESSAGES_LIMIT : 0,
  ].filter((value) => value > 0);
  const percentUsed = Math.min(100, Math.round(Math.max(0, ...fractions) * 100));

  return {
    plan: 'free',
    period: { start: start.toISOString(), end: end.toISOString() },
    conversationsUsed,
    conversationsLimit: FREE_CONVERSATIONS_LIMIT > 0 ? FREE_CONVERSATIONS_LIMIT : null,
    aiMessagesUsed,
    aiMessagesLimit: FREE_AI_MESSAGES_LIMIT > 0 ? FREE_AI_MESSAGES_LIMIT : null,
    percentUsed,
  };
}

export type LimitHit = 'conversations' | 'ai_messages' | null;

/** Guards a conversation-creating write against the active cap. */
export function conversationsLimitReached(used: number): LimitHit {
  if (FREE_CONVERSATIONS_LIMIT > 0 && used >= FREE_CONVERSATIONS_LIMIT) return 'conversations';
  return null;
}

/** Guards an AI assistant turn against the active cap (humans are never capped). */
export function aiMessagesLimitReached(used: number): LimitHit {
  if (FREE_AI_MESSAGES_LIMIT > 0 && used >= FREE_AI_MESSAGES_LIMIT) return 'ai_messages';
  return null;
}

/** Client-facing explanation for a 429, in Relay's honest voice. */
export function limitMessage(hit: Exclude<LimitHit, null>): string {
  if (hit === 'conversations') {
    return (
      `This free workspace reached its monthly limit of ${FREE_CONVERSATIONS_LIMIT} conversations. ` +
      'You can still request a human agent in an existing conversation — or raise the limit via FREE_CONVERSATIONS_LIMIT on your server.'
    );
  }
  return (
    `This free workspace reached its monthly limit of ${FREE_AI_MESSAGES_LIMIT} AI answers. ` +
    'You can still request a human agent — or raise the limit via FREE_AI_MESSAGES_LIMIT on your server.'
  );
}
