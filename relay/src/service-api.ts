/** Thin fetch wrapper for the Relay API. Handles admin auth, owner tokens and error shapes. */

import type {
  Conversation,
  ConversationDetail,
  CustomerStore,
  Faq,
  FaqInput,
  Health,
  KnowledgeGap,
  Message,
  Stats,
  SystemHealthReport,
  Usage,
} from './service-types';

const ADMIN_TOKEN_KEY = 'relay-admin-token';
export const CUSTOMER_STORE_KEY = 'relay-customer-session';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Raised when the backend requires (or rejects) an admin token. */
export class AuthError extends ApiError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'AuthError';
  }
}

export function getAdminToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* storage unavailable - the token simply won't persist */
  }
}

async function request<T>(path: string, init: RequestInit = {}, ownerToken?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers['Content-Type'] = 'application/json';
  if (path.startsWith('/api/admin')) {
    const admin = getAdminToken();
    if (admin) headers['x-admin-token'] = admin;
  }
  if (ownerToken) headers['x-conversation-token'] = ownerToken;

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('Cannot reach the Relay server. Check that it is running and try again.', 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `Request failed with status ${response.status}`;
    if (response.status === 401) throw new AuthError(message);
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

const post = <T,>(path: string, body?: unknown, token?: string) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }, token);

/* ---------------------------------------------------------------- *
 * Workspace (admin) API
 * ---------------------------------------------------------------- */

export const api = {
  health: () => request<Health>('/api/health'),

  getSystemHealth: () => request<SystemHealthReport>('/api/admin/system-health'),

  listConversations: () =>
    request<{ items: Conversation[]; total: number; limit: number; offset: number }>(
      '/api/admin/conversations',
    ),

  getConversation: (id: string) =>
    request<ConversationDetail>(`/api/admin/conversations/${encodeURIComponent(id)}`),

  getStats: (days: 7 | 30) => request<Stats>(`/api/admin/stats?days=${days}`),

  getUsage: () => request<Usage>('/api/admin/usage'),

  reply: (id: string, content: string) =>
    post<Message>(`/api/admin/conversations/${encodeURIComponent(id)}/reply`, { content }),

  resolve: (id: string) =>
    post<Conversation>(`/api/admin/conversations/${encodeURIComponent(id)}/resolve`),

  assign: (id: string, name: string) =>
    post<Conversation>(`/api/admin/conversations/${encodeURIComponent(id)}/assign`, { name }),

  listFaqs: () => request<Faq[]>('/api/faqs'),

  createFaq: (input: FaqInput) => post<Faq>('/api/admin/faqs', input),

  updateFaq: (id: string, input: FaqInput) =>
    request<Faq>(`/api/admin/faqs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  listKnowledgeGaps: () =>
    request<{ items: KnowledgeGap[] }>('/api/admin/knowledge-gaps'),

  resolveKnowledgeGap: (id: string) =>
    post<{ ok: true }>(`/api/admin/knowledge-gaps/${encodeURIComponent(id)}/resolve`),

  seedSampleKnowledge: () =>
    post<{ items: Faq[] }>('/api/admin/onboarding/sample-knowledge'),
};

/* ---------------------------------------------------------------- *
 * Auth API (cookie sessions)
 * ---------------------------------------------------------------- */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'agent';
}

export interface ManagedUser extends SessionUser {
  createdAt: string;
  lastLoginAt: string | null;
}

export const authApi = {
  me: () => request<{ user: SessionUser | null }>('/api/auth/me'),

  login: (email: string, password: string) =>
    post<{ user: SessionUser }>('/api/auth/login', { email, password }),

  logout: () => post<{ ok: true }>('/api/auth/logout'),

  listUsers: () => request<ManagedUser[]>('/api/auth/users'),

  createUser: (input: { email: string; name: string; role: 'admin' | 'agent'; password: string }) =>
    post<ManagedUser>('/api/auth/users', input),

  setRole: (id: string, role: 'admin' | 'agent') =>
    post<{ ok: true }>(`/api/auth/users/${encodeURIComponent(id)}/role`, { role }),

  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/api/auth/password', { currentPassword, newPassword }),
};

/* ---------------------------------------------------------------- *
 * Customer API
 * ---------------------------------------------------------------- */

export const customerApi = {
  create: (input: { customer?: string; email?: string } = {}) =>
    post<{ conversation: Conversation; accessToken: string }>('/api/conversations', input),

  get: (id: string, token: string) =>
    request<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`, {}, token),

  send: async (id: string, token: string, content: string, clientId: string): Promise<ConversationDetail> => {
    const detail = await post<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
      { content, clientId },
      token,
    );
    if (detail?.toolEvent) {
      const index = [...detail.messages].reverse().findIndex((message) => message.role === 'assistant');
      if (index !== -1) {
        const realIndex = detail.messages.length - 1 - index;
        detail.messages[realIndex] = { ...detail.messages[realIndex], tool: detail.toolEvent };
      }
    }
    return detail;
  },

  escalate: (id: string, token: string, reason?: string) =>
    post<Conversation>(`/api/conversations/${encodeURIComponent(id)}/escalate`, { reason }, token),

  rate: (id: string, token: string, score: number) =>
    post<Conversation>(`/api/conversations/${encodeURIComponent(id)}/rating`, { score }, token),

  feedback: (
    id: string,
    token: string,
    messageId: string,
    feedback: {
      helpful: boolean;
      reason?: 'incorrect' | 'didnt_answer' | 'missing_info' | 'need_human' | null;
      comment?: string | null;
    },
  ) =>
    post<{ ok: true; message: Message }>(
      `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/feedback`,
      feedback,
      token,
    ),
};

/* ---------------------------------------------------------------- *
 * Customer session persistence (localStorage)
 * ---------------------------------------------------------------- */

export function loadCustomerStore(): CustomerStore {
  try {
    const raw = localStorage.getItem(CUSTOMER_STORE_KEY);
    if (!raw) return { activeId: null, sessions: [] };
    const parsed = JSON.parse(raw) as Partial<CustomerStore>;
    if (!parsed || !Array.isArray(parsed.sessions)) return { activeId: null, sessions: [] };
    const sessions = parsed.sessions.filter(
      (entry): entry is CustomerStore['sessions'][number] =>
        Boolean(entry && typeof entry.id === 'string' && typeof entry.token === 'string'),
    );
    const activeId = sessions.some((s) => s.id === parsed.activeId) ? (parsed.activeId ?? null) : null;
    return { activeId, sessions };
  } catch {
    return { activeId: null, sessions: [] };
  }
}

export function saveCustomerStore(store: CustomerStore): void {
  try {
    localStorage.setItem(CUSTOMER_STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota / privacy-mode failures */
  }
}
