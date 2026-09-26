/**
 * Unit tests for the API client: error mapping, auth header handling,
 * CSRF attachment, and customer session persistence. No DOM or network —
 * fetch and web storage are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  AuthError,
  api,
  authApi,
  clearCsrfToken,
  customerApi,
  getAdminToken,
  loadCustomerStore,
  saveCustomerStore,
  setAdminToken,
  setCsrfToken,
} from './service-api';

function storageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  } as Storage;
}

interface CapturedCall {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: CapturedCall[];
let nextStatus = 200;
let nextBody: unknown = {};

function mockFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init: init as CapturedCall['init'] });
      const body = typeof nextBody === 'string' ? nextBody : JSON.stringify(nextBody);
      return new Response(body, { status: nextStatus });
    }),
  );
}

function headersOf(callIndex = 0): Record<string, string> {
  return calls[callIndex]?.init.headers ?? {};
}

beforeEach(() => {
  vi.unstubAllGlobals();
  mockFetch();
  nextStatus = 200;
  nextBody = {};
  clearCsrfToken();
  vi.stubGlobal('sessionStorage', storageStub());
  vi.stubGlobal('localStorage', storageStub());
  setAdminToken('');
});

describe('error mapping', () => {
  it('maps 401 to AuthError with the server message', async () => {
    nextStatus = 401;
    nextBody = { error: 'Authentication required' };
    await expect(api.getStats(7)).rejects.toMatchObject({
      name: 'AuthError',
      status: 401,
      message: 'Authentication required',
    });
  });

  it('maps error payloads to ApiError with status', async () => {
    nextStatus = 500;
    nextBody = { error: 'boom' };
    await expect(api.getStats(7)).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'boom',
    });
  });

  it('falls back to a status message for non-JSON bodies', async () => {
    nextStatus = 502;
    nextBody = '<html>gateway</html>';
    await expect(api.getStats(7)).rejects.toMatchObject({
      status: 502,
      message: 'Request failed with status 502',
    });
  });

  it('maps network failure to a status-0 ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(api.health()).rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  it('ApiError and AuthError carry their names', () => {
    expect(new ApiError('x', 400)).toMatchObject({ name: 'ApiError', status: 400 });
    expect(new AuthError('y')).toMatchObject({ name: 'AuthError', status: 401 });
  });
});

describe('auth headers', () => {
  it('sends x-admin-token only on admin paths when set', async () => {
    setAdminToken('secret');
    nextBody = [];
    await api.listFaqs();
    expect(headersOf(0)['x-admin-token']).toBeUndefined();
    await api.getStats(7);
    expect(headersOf(1)['x-admin-token']).toBe('secret');
    expect(getAdminToken()).toBe('secret');
  });

  it('clears the admin token', async () => {
    setAdminToken('secret');
    setAdminToken('');
    nextBody = [];
    await api.getStats(7);
    expect(headersOf(0)['x-admin-token']).toBeUndefined();
  });

  it('sends the owner token as x-conversation-token', async () => {
    nextBody = {};
    await customerApi.get('conv-1', 'owner-abc');
    expect(calls[0].url).toContain('conv-1');
    expect(headersOf(0)['x-conversation-token']).toBe('owner-abc');
  });
});

describe('CSRF attachment', () => {
  it('sends nothing without a token', async () => {
    nextBody = { ok: true };
    await authApi.logout().catch(() => undefined);
    expect(headersOf(0)['x-csrf-token']).toBeUndefined();
  });

  it('attaches the token to POST/PATCH/PUT/DELETE but never GET', async () => {
    setCsrfToken('csrf-123');
    nextBody = { user: null, csrfToken: 'csrf-123' };
    await authApi.me();
    expect(headersOf(0)['x-csrf-token']).toBeUndefined();
    nextBody = { ok: true };
    await authApi.logout().catch(() => undefined);
    expect(headersOf(1)['x-csrf-token']).toBe('csrf-123');
  });

  it('captures the token from login and clears it on logout', async () => {
    nextBody = { user: { id: '1', email: 'a@b.c', name: 'A', role: 'admin' }, csrfToken: 'tok-1' };
    await authApi.login('a@b.c', 'password-12345');
    nextBody = { ok: true };
    await authApi.logout();
    expect(headersOf(1)['x-csrf-token']).toBe('tok-1');
    // Cleared: the next mutation carries no token.
    await authApi.logout().catch(() => undefined);
    expect(headersOf(2)['x-csrf-token']).toBeUndefined();
  });

  it('captures the token from me()', async () => {
    nextBody = { user: null, csrfToken: 'tok-me' };
    await authApi.me();
    nextBody = { ok: true };
    await authApi.logout().catch(() => undefined);
    expect(headersOf(1)['x-csrf-token']).toBe('tok-me');
  });
});

describe('customer session persistence', () => {
  it('round-trips the store', () => {
    const store = {
      activeId: 'c1',
      sessions: [{ id: 'c1', token: 't1', title: 'Hi', createdAt: '2026-01-01' }],
    };
    saveCustomerStore(store);
    expect(loadCustomerStore()).toEqual(store);
  });

  it('returns an empty store for missing or corrupt data', () => {
    expect(loadCustomerStore()).toEqual({ activeId: null, sessions: [] });
    localStorage.setItem('relay-customer-session', 'not-json{');
    expect(loadCustomerStore()).toEqual({ activeId: null, sessions: [] });
  });

  it('drops invalid sessions and resets unknown activeId', () => {
    localStorage.setItem(
      'relay-customer-session',
      JSON.stringify({
        activeId: 'ghost',
        sessions: [
          { id: 'c1', token: 't1', title: 'Hi', createdAt: '2026-01-01' },
          { id: 42, token: null },
        ],
      }),
    );
    expect(loadCustomerStore()).toEqual({
      activeId: null,
      sessions: [{ id: 'c1', token: 't1', title: 'Hi', createdAt: '2026-01-01' }],
    });
  });
});
