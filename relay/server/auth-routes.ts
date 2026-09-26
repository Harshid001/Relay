/**
 * Authentication routes: /api/auth/*.
 *
 *   POST /api/auth/login      { email, password } → session cookie
 *   POST /api/auth/logout     clears the session
 *   GET  /api/auth/me         current user (null when signed out)
 *   GET  /api/auth/users      admin: list accounts
 *   POST /api/auth/users      admin: create an account (invite flow)
 *   POST /api/auth/users/:id/role  admin: change a role
 *   POST /api/auth/password   change own password
 *
 * Login is rate limited per IP, audit-logged, and never reveals whether an
 * account exists. Passwords follow the same validation on both ends.
 */

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';

import * as auth from './auth.js';
import { audit } from './auth.js';

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 80;

/* Brute-force guard: failed logins per IP+email in a sliding window. */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS_ENTRIES = 5000;

const attemptsCleanup = setInterval(() => {
  const now = Date.now();
  attempts.forEach((entry, key) => {
    if (entry.resetAt <= now) attempts.delete(key);
  });
  if (attempts.size > MAX_ATTEMPTS_ENTRIES) {
    attempts.clear();
  }
}, 5 * 60_000);
attemptsCleanup.unref?.();

function attemptKey(req: Request, email: string): string {
  return `${req.ip ?? 'unknown'}|${email.trim().toLowerCase()}`;
}

function loginThrottle(req: Request, res: Response, email: string): boolean {
  const key = attemptKey(req, email);
  const now = Date.now();
  const entry = attempts.get(key);
  if (entry && entry.resetAt > now && entry.count >= 8) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
    return false;
  }
  return true;
}

function recordFailure(req: Request, email: string): void {
  const key = attemptKey(req, email);
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 10 * 60_000 });
    return;
  }
  entry.count += 1;
}

function readBody(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length <= 200 && EMAIL_RE.test(trimmed) ? trimmed : null;
}

function cleanPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length >= 12 && value.length <= 200 ? value : null;
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NAME ? trimmed : null;
}

/** Wraps async handlers on the router. */
const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Enter a valid email and password.' });
      return;
    }
    if (!loginThrottle(req, res, email)) return;

    const user = await auth.authenticate(email, password);
    if (!user) {
      recordFailure(req, email);
      await audit(req, 'auth.login_failed', email);
      res.status(401).json({ error: 'Incorrect email or password.' });
      return;
    }

    attempts.delete(attemptKey(req, email));
    const token = await auth.createSession(user.id, req.get('user-agent') ?? null);
    auth.setSessionCookie(req, res, token);
    await audit(req, 'auth.login', user.email);
    res.json({ user });
  }),
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const token = req.get('cookie')?.split(';').find((part) => part.trim().startsWith(`${auth.SESSION_COOKIE}=`));
    if (token) {
      const raw = decodeURIComponent(token.split('=').slice(1).join('='));
      await auth.destroySession(raw);
    }
    auth.clearSessionCookie(res);
    if (req.user) await audit(req, 'auth.logout', req.user.email);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  wrap(async (req, res) => {
    res.json({ user: req.user ?? null });
  }),
);

authRouter.get(
  '/users',
  auth.requireRole('admin'),
  wrap(async (_req, res) => {
    res.json(await auth.listUsers());
  }),
);

authRouter.post(
  '/users',
  auth.requireRole('admin'),
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const email = cleanEmail(body.email);
    const name = cleanName(body.name);
    const password = cleanPassword(body.password);
    const role = body.role === 'agent' ? 'agent' : body.role === 'admin' ? 'admin' : null;

    if (!email || !name || !password || !role) {
      res.status(400).json({
        error:
          'email (valid), name (1-80 chars), password (12-200 chars) and role (admin|agent) are required.',
      });
      return;
    }
    if (await auth.findUserByEmail(email)) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const user = await auth.createUser({
      email,
      name,
      role,
      password,
      invitedBy: req.user?.id ?? null,
    });
    await audit(req, 'auth.user_created', email, { role });
    res.status(201).json(user);
  }),
);

authRouter.post(
  '/users/:id/role',
  auth.requireRole('admin'),
  wrap(async (req, res) => {
    const targetId = req.params.id;
    const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'agent' ? 'agent' : null;
    if (!role) {
      res.status(400).json({ error: 'role must be admin or agent.' });
      return;
    }
    if (!req.user) return;
    if (req.user.id === targetId) {
      res.status(400).json({ error: 'Role not changed. You cannot change your own role.' });
      return;
    }
    const changed = await auth.setUserRole(req.user, targetId, role);
    if (!changed) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    await audit(req, 'auth.role_changed', targetId, { role });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password',
  auth.requireAuth,
  wrap(async (req, res) => {
    const body = readBody(req.body);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = cleanPassword(body.newPassword);
    if (!next) {
      res.status(400).json({ error: 'New password must be 12-200 characters.' });
      return;
    }
    if (!req.user) return;
    const changed = await auth.changePassword(req.user.id, current, next);
    if (!changed) {
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }
    await audit(req, 'auth.password_changed', req.user.email);
    res.json({ ok: true });
  }),
);
