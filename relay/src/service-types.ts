/** Shared types mirroring the Relay backend contract exactly. */

export type Intent = 'refund' | 'order' | 'technical' | 'general';
export type ConversationStatus = 'open' | 'waiting' | 'resolved';
export type MessageRole = 'user' | 'assistant' | 'human' | 'system';
export type Mode = 'demo' | 'live';

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

export interface SourceRef {
  id: string;
  title: string;
}

/** A scripted tool call the assistant performed during a turn. */
export interface ToolEvent {
  name: 'lookup_order';
  args: { orderId: string };
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
  provider?: 'demo' | 'codebuddy' | 'human';
  /** Present on the assistant reply that performed a tool call. */
  tool?: ToolEvent | null;
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

export interface FaqInput {
  title: string;
  answer: string;
  category: Intent;
  tags: string[];
}

export interface VolumePoint {
  date: string;
  label: string;
  ai: number;
  human: number;
}

export interface Stats {
  total: number;
  resolved: number;
  aiResolutions: number;
  humanHandoffs: number;
  resolutionRate: number;
  csat: number | null;
  avgResponseSeconds: number | null;
  waiting: number;
  ratingCount: number;
  volume: VolumePoint[];
  intents: Array<{ intent: Intent; count: number }>;
  satisfaction: Array<{ score: number; count: number }>;
  mode: Mode;
}

export interface Health {
  status: string;
  mode: Mode;
  adminAuthRequired: boolean;
  plan?: 'free';
}

export interface SystemComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message?: string;
  latencyMs?: number | null;
  details?: Record<string, unknown>;
}

export interface SystemHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptimeSeconds: number;
  components: {
    api: SystemComponentHealth;
    database: SystemComponentHealth;
    aiProvider: SystemComponentHealth;
    realtimeSse: SystemComponentHealth;
    knowledgeBase: SystemComponentHealth;
  };
  telemetry: {
    ai: {
      requestsTotal: number;
      failuresTotal: number;
      avgLatencyMs: number | null;
      lastLatencyMs: number | null;
    };
    http: {
      requestsTotal: number;
      responses2xx: number;
      responses4xx: number;
      responses5xx: number;
      avgDurationMs: number | null;
    };
    database: {
      pingLatencyMs: number | null;
      errorsTotal: number;
    };
    realtimeSse: {
      activeSubscribers: number;
      failuresTotal: number;
    };
    knowledgeBase: {
      searchesTotal: number;
      zeroMatchSearches: number;
      faqCount: number;
    };
    planLimits?: {
      conversationsRejected: number;
      aiMessagesRejected: number;
    };
    handoffs?: {
      total: number;
      byReason: Record<string, number>;
    };
  };
}

/** Free-plan usage for the current calendar month (GET /api/admin/usage). */
export interface Usage {
  plan: 'free';
  period: { start: string; end: string };
  conversationsUsed: number;
  conversationsLimit: number | null;
  aiMessagesUsed: number;
  aiMessagesLimit: number | null;
  percentUsed: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  /** Transient: set on the turn that performed a tool call. */
  toolEvent?: ToolEvent | null;
}

export interface CustomerSession {
  id: string;
  token: string;
  title: string;
  createdAt: string;
}

export interface CustomerStore {
  activeId: string | null;
  sessions: CustomerSession[];
}
