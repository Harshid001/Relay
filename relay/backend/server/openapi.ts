/**
 * OpenAPI 3.1 reference for the Relay API, served as JSON from
 * GET /api/openapi.json (and /api/v1/openapi.json).
 *
 * Source of truth for routes: server/index.ts (apiRouter) and
 * server/auth-routes.ts (authRouter, mounted at /auth). Field shapes mirror
 * frontend/src/service-types.ts, which mirrors the backend contract exactly.
 *
 * Response envelopes: the legacy /api/* routes return payloads directly
 * (errors as { error: string }). The versioned /api/v1/* routes wrap them:
 * success as { success: true, data: <payload> }, errors as
 * { success: false, error: { code, message } } (see server/http.ts).
 */

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

const ErrorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string', example: 'Authentication required' } },
};

const ConversationSchema = {
  type: 'object',
  required: [
    'id', 'customer', 'email', 'title', 'intent', 'status', 'assignee', 'rating',
    'createdAt', 'updatedAt', 'preview', 'isDemo', 'escalationReason',
  ],
  properties: {
    id: { type: 'string' },
    customer: { type: 'string' },
    email: { type: 'string' },
    title: { type: 'string' },
    intent: { type: 'string', enum: ['refund', 'order', 'technical', 'general'] },
    status: { type: 'string', enum: ['open', 'waiting', 'resolved'] },
    assignee: { type: ['string', 'null'] },
    rating: { type: ['number', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    preview: { type: 'string' },
    isDemo: { type: 'boolean' },
    escalationReason: { type: ['string', 'null'] },
  },
};

const MessageSchema = {
  type: 'object',
  required: ['id', 'conversationId', 'role', 'content', 'createdAt', 'sources'],
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    role: { type: 'string', enum: ['user', 'assistant', 'human', 'system'] },
    content: { type: 'string' },
    createdAt: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: { id: { type: 'string' }, title: { type: 'string' } },
      },
    },
    provider: { type: 'string', enum: ['demo', 'codebuddy', 'human'] },
  },
};

const FaqSchema = {
  type: 'object',
  required: ['id', 'title', 'answer', 'category', 'tags', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    answer: { type: 'string' },
    category: { type: 'string', enum: ['refund', 'order', 'technical', 'general'] },
    tags: { type: 'array', items: { type: 'string' } },
    updatedAt: { type: 'string' },
  },
};

const SessionUserSchema = {
  type: 'object',
  required: ['id', 'email', 'name', 'role'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['admin', 'agent'] },
  },
};

function op(
  summary: string,
  tags: string[],
  responses: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { summary, tags, ...extra, responses };
}

function jsonRef(name: string): Record<string, unknown> {
  return { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } };
}

export const openapi: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Relay API',
    version: '1.0.0',
    description:
      'Customer support workspace: customer chat, human handoff queue, knowledge base, accounts and system health. ' +
      'Cookie-session mutations require the x-csrf-token header (see GET /auth/me). ' +
      'All /api/v1/* responses use the standard envelope; /api/* returns payloads directly.',
  },
  servers: [{ url: '/api', description: 'Same-origin API (legacy unwrapped)' }],
  tags: [
    { name: 'System', description: 'Health, metrics and API reference' },
    { name: 'Customer', description: 'Owner-token chat endpoints' },
    { name: 'Auth', description: 'Accounts, sessions and roles' },
    { name: 'Admin', description: 'Workspace queue, knowledge and usage' },
  ],
  paths: {
    '/health': {
      get: op('Liveness + mode probe', ['System'], {
        '200': { description: 'ok/degraded with database check and plan info', ...jsonRef('Health') },
        '503': { description: 'Database unreachable', ...jsonRef('Error') },
      }),
    },
    '/metrics': {
      get: op('Prometheus text metrics', ['System'], {
        '200': { description: 'relay_requests_total et al (text/plain)' },
      }),
    },
    '/health/system': {
      get: op('Public component health + telemetry snapshot', ['System'], {
        '200': { description: 'healthy/degraded/unhealthy per component', ...jsonRef('SystemHealthReport') },
        '503': { description: 'Unhealthy', ...jsonRef('SystemHealthReport') },
      }),
    },
    '/openapi.json': {
      get: op('This API reference', ['System'], {
        '200': { description: 'OpenAPI 3.1 document' },
      }),
    },
    '/faqs': {
      get: op('List public knowledge base articles', ['Customer'], {
        '200': { description: 'FAQ articles', ...jsonRef('FaqList') },
      }),
    },
    '/conversations': {
      post: op('Open a customer conversation (returns owner access token)', ['Customer'], {
        '201': { description: 'Conversation + accessToken', ...jsonRef('ConversationCreated') },
        '400': { description: 'Validation error', ...jsonRef('Error') },
        '429': { description: 'Monthly conversation cap reached', ...jsonRef('Error') },
      }),
    },
    '/conversations/{id}': {
      get: op(
        'Read one conversation (owner token)',
        ['Customer'],
        {
          '200': { description: 'Conversation detail', ...jsonRef('ConversationDetail') },
          '404': { description: 'Unknown id or wrong owner token (masked)', ...jsonRef('Error') },
        },
        {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ ConversationToken: [] }],
        },
      ),
    },
    '/conversations/{id}/messages': {
      post: op(
        'Send a customer message (idempotent via clientId)',
        ['Customer'],
        {
          '200': { description: 'Updated conversation detail', ...jsonRef('ConversationDetail') },
          '400': { description: 'Empty or >4000 chars', ...jsonRef('Error') },
          '404': { description: 'Unknown id or wrong owner token', ...jsonRef('Error') },
        },
        {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ ConversationToken: [] }],
        },
      ),
    },
    '/conversations/{id}/escalate': {
      post: op(
        'Customer asks for a human',
        ['Customer'],
        {
          '200': { description: 'Conversation now waiting', ...jsonRef('Conversation') },
          '404': { description: 'Unknown id or wrong owner token', ...jsonRef('Error') },
        },
        {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ ConversationToken: [] }],
        },
      ),
    },
    '/conversations/{id}/rating': {
      post: op(
        'Record one satisfaction rating (single, immutable)',
        ['Customer'],
        {
          '200': { description: 'Rated conversation', ...jsonRef('Conversation') },
          '400': { description: 'Bad score', ...jsonRef('Error') },
          '404': { description: 'Unknown id or wrong owner token', ...jsonRef('Error') },
          '409': { description: 'Already rated', ...jsonRef('Error') },
        },
        {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          security: [{ ConversationToken: [] }],
        },
      ),
    },
    '/conversations/{id}/messages/{messageId}/feedback': {
      post: op(
        'Rate one assistant message as helpful or not',
        ['Customer'],
        {
          '200': { description: 'Updated message', ...jsonRef('Message') },
          '404': { description: 'Unknown id or wrong owner token', ...jsonRef('Error') },
        },
        {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'messageId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          security: [{ ConversationToken: [] }],
        },
      ),
    },
    '/auth/login': {
      post: op('Password login (sets relay_session cookie, returns CSRF token)', ['Auth'], {
        '200': { description: 'User + csrfToken', ...jsonRef('SessionResponse') },
        '400': { description: 'Missing fields', ...jsonRef('Error') },
        '401': { description: 'Incorrect email or password', ...jsonRef('Error') },
        '429': { description: 'Throttled after 8 failures', ...jsonRef('Error') },
      }),
    },
    '/auth/logout': {
      post: op('Destroy the session server-side (CSRF token required)', ['Auth'], {
        '200': { description: 'Logged out' },
        '403': { description: 'Missing/invalid CSRF token', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }] }),
    },
    '/auth/me': {
      get: op('Current session user + CSRF token re-issue', ['Auth'], {
        '200': { description: 'User or null', ...jsonRef('SessionResponse') },
      }),
    },
    '/auth/config': {
      get: op('Auth capabilities (Google client id, email verification)', ['Auth'], {
        '200': { description: 'Capabilities' },
      }),
    },
    '/auth/email/send-code': {
      post: op('Send 6-digit code + magic link (60s per-email throttle)', ['Auth'], {
        '200': { description: 'Sent (debugCode/debugToken only in non-prod)' },
        '400': { description: 'Bad email', ...jsonRef('Error') },
        '429': { description: 'Throttled', ...jsonRef('Error') },
      }),
    },
    '/auth/email/verify': {
      post: op('Verify code or magic token, create session (single-use)', ['Auth'], {
        '200': { description: 'User + csrfToken', ...jsonRef('SessionResponse') },
        '400': { description: 'No code or token', ...jsonRef('Error') },
        '401': { description: 'Invalid/expired/replayed', ...jsonRef('Error') },
      }),
    },
    '/auth/google': {
      post: op('Google ID-token login (aud + email_verified checked)', ['Auth'], {
        '200': { description: 'User + csrfToken', ...jsonRef('SessionResponse') },
        '400': { description: 'Missing credential', ...jsonRef('Error') },
        '401': { description: 'Verification failed', ...jsonRef('Error') },
      }),
    },
    '/auth/users': {
      get: op('List accounts', ['Auth'], {
        '200': { description: 'Managed users' },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '403': { description: 'Non-admin', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
      post: op('Invite an agent/admin (admin only)', ['Auth'], {
        '201': { description: 'Created user' },
        '400': { description: 'Bad fields', ...jsonRef('Error') },
        '403': { description: 'Non-admin or missing CSRF token', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/auth/users/{id}/role': {
      post: op('Change role (admin only, no self-demotion)', ['Auth'], {
        '200': { description: 'Updated' },
        '400': { description: 'Self-demotion or bad role', ...jsonRef('Error') },
        '403': { description: 'Non-admin or missing CSRF token', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/auth/password': {
      post: op('Change own password', ['Auth'], {
        '200': { description: 'Changed' },
        '401': { description: 'Unauthenticated or wrong current password', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }] }),
    },
    '/admin/system-health': {
      get: op('Authed component health + telemetry', ['Admin'], {
        '200': { description: 'Report', ...jsonRef('SystemHealthReport') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '503': { description: 'Unhealthy', ...jsonRef('SystemHealthReport') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/events': {
      get: op('Workspace realtime stream (SSE, text/event-stream)', ['Admin'], {
        '200': { description: 'Event stream' },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/conversations': {
      get: op('List workspace conversations', ['Admin'], {
        '200': { description: 'Items + total/limit/offset' },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/conversations/{id}': {
      get: op('Full transcript + context for one conversation', ['Admin'], {
        '200': { description: 'Conversation detail', ...jsonRef('ConversationDetail') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/stats': {
      get: op('Resolution/CSAT/volume statistics (?days=7|30)', ['Admin'], {
        '200': { description: 'Stats', ...jsonRef('Stats') },
        '400': { description: 'Bad days value', ...jsonRef('Error') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/usage': {
      get: op('Free-plan usage for the current month', ['Admin'], {
        '200': { description: 'Usage', ...jsonRef('Usage') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/conversations/{id}/reply': {
      post: op('Human agent reply in context', ['Admin'], {
        '200': { description: 'Posted message', ...jsonRef('Message') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '403': { description: 'Missing CSRF token (cookie auth)', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/conversations/{id}/resolve': {
      post: op('Resolve a conversation', ['Admin'], {
        '200': { description: 'Resolved conversation', ...jsonRef('Conversation') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/conversations/{id}/assign': {
      post: op('Assign to an agent', ['Admin'], {
        '200': { description: 'Assigned conversation', ...jsonRef('Conversation') },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/faqs': {
      post: op('Create a knowledge base article (admin only)', ['Admin'], {
        '200': { description: 'Created FAQ', ...jsonRef('Faq') },
        '400': { description: 'Validation error', ...jsonRef('Error') },
        '403': { description: 'Non-admin or missing CSRF token', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/faqs/{id}': {
      patch: op('Edit a knowledge base article (admin only)', ['Admin'], {
        '200': { description: 'Updated FAQ', ...jsonRef('Faq') },
        '403': { description: 'Non-admin or missing CSRF token', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/knowledge-gaps': {
      get: op('Unanswerable-question backlog', ['Admin'], {
        '200': { description: 'Open gaps' },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
    '/admin/knowledge-gaps/{id}/resolve': {
      post: op('Mark a knowledge gap resolved', ['Admin'], {
        '200': { description: 'Resolved' },
        '401': { description: 'Unauthenticated', ...jsonRef('Error') },
        '404': { description: 'Unknown id', ...jsonRef('Error') },
      }, {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        security: [{ CookieAuth: [] }, { AdminToken: [] }],
      }),
    },
    '/admin/onboarding/sample-knowledge': {
      post: op('Load the 15 sample policies on demand (admin only)', ['Admin'], {
        '200': { description: 'Seeded items' },
        '403': { description: 'Non-admin or missing CSRF token', ...jsonRef('Error') },
      }, { security: [{ CookieAuth: [] }, { AdminToken: [] }] }),
    },
  },
  components: {
    schemas: {
      Error: ErrorSchema,
      Conversation: ConversationSchema,
      Message: MessageSchema,
      ConversationDetail: {
        type: 'object',
        required: ['conversation', 'messages'],
        properties: {
          conversation: { $ref: '#/components/schemas/Conversation' },
          messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } },
        },
      },
      ConversationCreated: {
        type: 'object',
        required: ['conversation', 'accessToken'],
        properties: {
          conversation: { $ref: '#/components/schemas/Conversation' },
          accessToken: { type: 'string', description: 'Owner bearer token (x-conversation-token)' },
        },
      },
      Faq: FaqSchema,
      FaqList: { type: 'array', items: { $ref: '#/components/schemas/Faq' } },
      SessionUser: SessionUserSchema,
      SessionResponse: {
        type: 'object',
        required: ['user'],
        properties: {
          user: {
            oneOf: [{ $ref: '#/components/schemas/SessionUser' }, { type: 'null' }],
          },
          csrfToken: {
            type: ['string', 'null'],
            description: 'Per-session x-csrf-token for cookie-authenticated mutations',
          },
        },
      },
      Health: {
        type: 'object',
        required: ['status', 'mode', 'adminAuthRequired'],
        properties: {
          status: { type: 'string' },
          mode: { type: 'string', enum: ['demo', 'live'] },
          adminAuthRequired: { type: 'boolean' },
          plan: { type: 'string' },
        },
      },
      SystemHealthReport: {
        type: 'object',
        required: ['status', 'timestamp', 'uptimeSeconds', 'components', 'telemetry'],
        properties: {
          status: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy'] },
          timestamp: { type: 'string' },
          uptimeSeconds: { type: 'number' },
          components: { type: 'object' },
          telemetry: { type: 'object' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          resolved: { type: 'number' },
          aiResolutions: { type: 'number' },
          humanHandoffs: { type: 'number' },
          resolutionRate: { type: 'number' },
          csat: { type: ['number', 'null'] },
          avgResponseSeconds: { type: ['number', 'null'] },
          waiting: { type: 'number' },
          ratingCount: { type: 'number' },
          mode: { type: 'string', enum: ['demo', 'live'] },
        },
      },
      Usage: {
        type: 'object',
        properties: {
          plan: { type: 'string' },
          conversationsUsed: { type: 'number' },
          conversationsLimit: { type: ['number', 'null'] },
          aiMessagesUsed: { type: 'number' },
          aiMessagesLimit: { type: ['number', 'null'] },
          percentUsed: { type: 'number' },
        },
      },
    },
    securitySchemes: {
      AdminToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-token',
        description: 'Legacy shared-secret admin auth (pre-account deployments)',
      },
      ConversationToken: {
        type: 'apiKey',
        in: 'header',
        name: 'x-conversation-token',
        description: 'Per-conversation owner token returned at creation',
      },
      CookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'relay_session',
        description:
          'Account session cookie. State-changing requests must also send the per-session x-csrf-token header.',
      },
    },
  },
};
