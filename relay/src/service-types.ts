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
